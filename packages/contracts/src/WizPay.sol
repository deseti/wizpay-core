// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IERC20.sol";
import "./IFXEngine.sol";

/**
 * @title WizPay
 * @dev Non-custodial Smart Payment Router for ARC blockchain
 * Enables atomic cross-stablecoin payments with built-in slippage protection
 * 
 * Features:
 * - Generic FX engine integration (works with StableFX, Uniswap, etc.)
 * - Emergency pause mechanism
 * - Optional fee collection
 * - Token whitelist for security
 * - Multi-decimal support (handles USDC 6 vs 18 decimals)
 * - Non-custodial design
 */
contract WizPay is Ownable, Pausable, ReentrancyGuard {
    // Address of the FX Engine (can be StableFX, Uniswap, or any DEX)
    IFXEngine public fxEngine;

    // Fee configuration (in basis points: 10000 = 100%)
    uint256 public feeBps;
    uint256 public constant MAX_FEE_BPS = 100; // 1% max fee
    address public feeCollector;

    // Token whitelist
    mapping(address => bool) public whitelistedTokens;
    bool public whitelistEnabled;

    // Events
    event PaymentRouted(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );

    event FXEngineUpdated(address indexed oldEngine, address indexed newEngine);
    
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    
    event TokenWhitelisted(address indexed token, bool status);
    
    event WhitelistStatusChanged(bool enabled);
    
    event FeeCollected(address indexed token, uint256 amount);

    event BatchPaymentRouted(
        address indexed sender,
        address tokenIn,
        address tokenOut,
        uint256 totalAmountIn,
        uint256 totalAmountOut,
        uint256 totalFees,
        uint256 recipientCount,
        string referenceId
    );

    event EmergencyWithdraw(
        address indexed token,
        uint256 amount,
        address indexed to
    );

    /**
     * @dev Constructor sets the FX Engine address and initial configuration
     * @param _fxEngine Address of the FX Engine contract (StableFX, Uniswap, etc.)
     * @param _feeCollector Address that receives collected fees
     * @param _feeBps Fee in basis points (100 = 1%)
     */
    constructor(
        address _fxEngine,
        address _feeCollector,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        require(_fxEngine != address(0), "WizPay: FX Engine cannot be zero address");
        require(_feeBps <= MAX_FEE_BPS, "WizPay: Fee exceeds maximum");
        
        fxEngine = IFXEngine(_fxEngine);
        feeCollector = _feeCollector;
        feeBps = _feeBps;
        whitelistEnabled = false;
    }

    /**
     * @dev Core function: Routes a payment through the FX Engine
     * @param tokenIn Address of the input stablecoin (sender pays with this)
     * @param tokenOut Address of the output stablecoin (recipient receives this)
     * @param amountIn Amount of input tokens to send
     * @param minAmountOut Minimum acceptable output amount (slippage protection)
     * @param recipient Address that will receive the output tokens
     * @return amountOut The actual amount of output tokens sent to recipient
     */
    function routeAndPay(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        return _processPayment(tokenIn, tokenOut, amountIn, minAmountOut, recipient);
    }

    /**
     * @dev Batch Payout: Process multiple payments in a single atomic transaction
     * @param tokenIn Address of the input stablecoin (sender pays with this)
     * @param tokenOut Address of the output stablecoin (recipients receive this)
     * @param recipients Array of recipient addresses
     * @param amountsIn Array of input amounts per recipient
     * @param minAmountsOut Array of minimum acceptable outputs per recipient (slippage protection)
     * @param referenceId Human-readable batch ID for accounting (e.g. 'Gaji_April_2026')
     * @return totalOut Total output tokens distributed across all recipients
     *
     * Requirements:
     * - All arrays must have the same length
     * - Sender must have approved WizPay to spend the sum of all amountsIn
     * - Entire batch is atomic: if any single payment fails, all revert
     */
    function batchRouteAndPay(
        address tokenIn,
        address tokenOut,
        address[] calldata recipients,
        uint256[] calldata amountsIn,
        uint256[] calldata minAmountsOut,
        string memory referenceId
    ) external nonReentrant whenNotPaused returns (uint256 totalOut) {
        _validateBatchInputs(recipients.length, amountsIn.length, minAmountsOut.length, referenceId);
        return _batchRouteAndPay(tokenIn, tokenOut, recipients, amountsIn, minAmountsOut, referenceId);
    }

    /**
     * @dev Mixed batch payout: a single input token can be routed into different
     * output tokens per recipient in one atomic transaction.
     */
    function batchRouteAndPay(
        address tokenIn,
        address[] calldata tokenOuts,
        address[] calldata recipients,
        uint256[] calldata amountsIn,
        uint256[] calldata minAmountsOut,
        string memory referenceId
    ) external nonReentrant whenNotPaused returns (uint256 totalOut) {
        _validateBatchInputs(recipients.length, tokenOuts.length, amountsIn.length, minAmountsOut.length, referenceId);

        uint256 totalIn = 0;
        uint256 totalFees = 0;
        address summaryTokenOut = tokenOuts[0];

        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amountOut = _processPayment(
                tokenIn,
                tokenOuts[i],
                amountsIn[i],
                minAmountsOut[i],
                recipients[i]
            );
            totalIn += amountsIn[i];
            totalOut += amountOut;
            totalFees += _calculateFee(amountsIn[i]);

            if (summaryTokenOut != tokenOuts[i]) {
                summaryTokenOut = address(0);
            }
        }

        emit BatchPaymentRouted(
            msg.sender,
            tokenIn,
            summaryTokenOut,
            totalIn,
            totalOut,
            totalFees,
            recipients.length,
            referenceId
        );

        return totalOut;
    }

    /**
     * @dev Internal: shared payment logic used by both routeAndPay and batchRouteAndPay
     */
    function _processPayment(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) internal returns (uint256 amountOut) {
        require(tokenIn != address(0), "WizPay: tokenIn cannot be zero address");
        require(tokenOut != address(0), "WizPay: tokenOut cannot be zero address");
        require(amountIn > 0, "WizPay: amountIn must be greater than zero");
        require(recipient != address(0), "WizPay: recipient cannot be zero address");

        // Check whitelist if enabled
        if (whitelistEnabled) {
            require(whitelistedTokens[tokenIn], "WizPay: tokenIn not whitelisted");
            require(whitelistedTokens[tokenOut], "WizPay: tokenOut not whitelisted");
        }

        // Step 1: Pull tokens from sender to this contract
        bool success = IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        require(success, "WizPay: transferFrom failed");

        // Step 2: Calculate fee (if any)
        uint256 feeAmount = _calculateFee(amountIn);
        uint256 amountAfterFee = amountIn - feeAmount;

        if (feeAmount > 0) {
            success = IERC20(tokenIn).transfer(feeCollector, feeAmount);
            require(success, "WizPay: fee transfer failed");
            emit FeeCollected(tokenIn, feeAmount);
        }

        if (tokenIn == tokenOut) {
            require(
                amountAfterFee >= minAmountOut,
                "WizPay: direct transfer below minimum output"
            );

            success = IERC20(tokenOut).transfer(recipient, amountAfterFee);
            require(success, "WizPay: direct transfer failed");

            emit PaymentRouted(
                msg.sender,
                recipient,
                tokenIn,
                tokenOut,
                amountIn,
                amountAfterFee,
                feeAmount
            );

            return amountAfterFee;
        }

        // Step 3: Approve FX Engine to spend our tokens
        success = IERC20(tokenIn).approve(address(fxEngine), 0);
        require(success, "WizPay: approve reset failed");
        success = IERC20(tokenIn).approve(address(fxEngine), amountAfterFee);
        require(success, "WizPay: approve failed");

        // Step 4: Perform atomic swap through FX Engine
        // Adjust minAmountOut proportionally if fee was taken
        uint256 adjustedMinOut = minAmountOut;
        if (feeAmount > 0 && amountIn > 0) {
            adjustedMinOut = (minAmountOut * amountAfterFee) / amountIn;
        }

        amountOut = fxEngine.swap(
            tokenIn,
            tokenOut,
            amountAfterFee,
            adjustedMinOut,
            recipient  // Tokens go directly to recipient
        );

        // Emit event for transparency and tracking
        emit PaymentRouted(
            msg.sender,
            recipient,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            feeAmount
        );

        return amountOut;
    }

    function _batchRouteAndPay(
        address tokenIn,
        address tokenOut,
        address[] calldata recipients,
        uint256[] calldata amountsIn,
        uint256[] calldata minAmountsOut,
        string memory referenceId
    ) internal returns (uint256 totalOut) {
        uint256 totalIn = 0;
        uint256 totalFees = 0;

        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amountOut = _processPayment(
                tokenIn,
                tokenOut,
                amountsIn[i],
                minAmountsOut[i],
                recipients[i]
            );
            totalIn += amountsIn[i];
            totalOut += amountOut;
            totalFees += _calculateFee(amountsIn[i]);
        }

        emit BatchPaymentRouted(
            msg.sender,
            tokenIn,
            tokenOut,
            totalIn,
            totalOut,
            totalFees,
            recipients.length,
            referenceId
        );

        return totalOut;
    }

    function _validateBatchInputs(
        uint256 recipientsLength,
        uint256 amountsLength,
        uint256 minAmountsLength,
        string memory referenceId
    ) internal pure {
        require(recipientsLength > 0, "WizPay: empty batch");
        require(
            recipientsLength == amountsLength && recipientsLength == minAmountsLength,
            "WizPay: array length mismatch"
        );
        require(recipientsLength <= 50, "WizPay: batch too large");
        require(bytes(referenceId).length > 0, "WizPay: referenceId required");
        require(bytes(referenceId).length <= 64, "WizPay: referenceId too long");
    }

    function _validateBatchInputs(
        uint256 recipientsLength,
        uint256 tokenOutsLength,
        uint256 amountsLength,
        uint256 minAmountsLength,
        string memory referenceId
    ) internal pure {
        require(recipientsLength == tokenOutsLength, "WizPay: array length mismatch");
        _validateBatchInputs(recipientsLength, amountsLength, minAmountsLength, referenceId);
    }

    function _calculateFee(uint256 amountIn) internal view returns (uint256 feeAmount) {
        if (feeBps == 0 || feeCollector == address(0)) {
            return 0;
        }

        return (amountIn * feeBps) / 10000;
    }

    /**
     * @dev Allows owner to update the FX Engine address
     * @param _fxEngine New FX Engine address
     */
    function updateFXEngine(address _fxEngine) external onlyOwner {
        require(_fxEngine != address(0), "WizPay: FX Engine cannot be zero address");
        address oldEngine = address(fxEngine);
        fxEngine = IFXEngine(_fxEngine);
        emit FXEngineUpdated(oldEngine, _fxEngine);
    }

    /**
     * @dev Update fee configuration
     * @param _feeBps New fee in basis points (100 = 1%)
     */
    function updateFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_FEE_BPS, "WizPay: Fee exceeds maximum");
        uint256 oldFee = feeBps;
        feeBps = _feeBps;
        emit FeeUpdated(oldFee, _feeBps);
    }

    /**
     * @dev Update fee collector address
     * @param _feeCollector New fee collector address
     */
    function updateFeeCollector(address _feeCollector) external onlyOwner {
        address oldCollector = feeCollector;
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(oldCollector, _feeCollector);
    }

    /**
     * @dev Whitelist or delist a token
     * @param token Token address
     * @param status True to whitelist, false to delist
     */
    function setTokenWhitelist(address token, bool status) external onlyOwner {
        require(token != address(0), "WizPay: Token cannot be zero address");
        whitelistedTokens[token] = status;
        emit TokenWhitelisted(token, status);
    }

    /**
     * @dev Batch whitelist multiple tokens
     * @param tokens Array of token addresses
     * @param status True to whitelist, false to delist
     */
    function batchSetTokenWhitelist(address[] calldata tokens, bool status) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            require(tokens[i] != address(0), "WizPay: Token cannot be zero address");
            whitelistedTokens[tokens[i]] = status;
            emit TokenWhitelisted(tokens[i], status);
        }
    }

    /**
     * @dev Enable or disable whitelist enforcement
     * @param enabled True to enable whitelist, false to disable
     */
    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
        emit WhitelistStatusChanged(enabled);
    }

    /**
     * @dev Emergency token rescue for stuck/accidentally sent tokens
     * @param token Token address to withdraw
     * @param amount Amount to withdraw
     *
     * Only callable by owner. Use when tokens are sent directly to the
     * contract address without going through routeAndPay.
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "WizPay: Invalid token");
        require(amount > 0, "WizPay: Invalid amount");
        
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= amount, "WizPay: Insufficient balance");
        
        require(
            IERC20(token).transfer(owner(), amount),
            "WizPay: Transfer failed"
        );
        
        emit EmergencyWithdraw(token, amount, owner());
    }

    /**
     * @dev Pause the contract (emergency stop)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Get estimated output amount for a potential payment
     * @param tokenIn Address of the input stablecoin
     * @param tokenOut Address of the output stablecoin
     * @param amountIn Amount of input tokens
     * @return estimatedAmountOut Estimated amount of output tokens
     */
    function getEstimatedOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 estimatedAmountOut) {
        if (amountIn == 0) {
            return 0;
        }

        uint256 feeAmount = _calculateFee(amountIn);
        uint256 amountAfterFee = amountIn - feeAmount;

        if (tokenIn == tokenOut) {
            return amountAfterFee;
        }

        return fxEngine.getEstimatedAmount(tokenIn, tokenOut, amountAfterFee);
    }

    function getBatchEstimatedOutputs(
        address tokenIn,
        address[] calldata tokenOuts,
        uint256[] calldata amountsIn
    )
        external
        view
        returns (
            uint256[] memory estimatedAmountsOut,
            uint256 totalEstimatedOut,
            uint256 totalFees
        )
    {
        require(tokenOuts.length == amountsIn.length, "WizPay: array length mismatch");

        estimatedAmountsOut = new uint256[](amountsIn.length);

        for (uint256 i = 0; i < amountsIn.length; i++) {
            uint256 feeAmount = _calculateFee(amountsIn[i]);
            uint256 amountAfterFee = amountsIn[i] - feeAmount;

            totalFees += feeAmount;

            if (tokenIn == tokenOuts[i]) {
                estimatedAmountsOut[i] = amountAfterFee;
            } else {
                estimatedAmountsOut[i] = fxEngine.getEstimatedAmount(
                    tokenIn,
                    tokenOuts[i],
                    amountAfterFee
                );
            }

            totalEstimatedOut += estimatedAmountsOut[i];
        }
    }
}
