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
    error FxEngineZeroAddress();
    error FeeExceedsMaximum(uint256 feeBps, uint256 maxFeeBps);
    error TokenInZeroAddress();
    error TokenOutZeroAddress();
    error RecipientZeroAddress();
    error TokenZeroAddress();
    error AmountMustBeGreaterThanZero();
    error TokenNotWhitelisted(address token);
    error TokenTransferFromFailed(address token, address from, address to, uint256 amount);
    error TokenTransferFailed(address token, address to, uint256 amount);
    error TokenApproveFailed(address token, address spender, uint256 amount);
    error DirectTransferBelowMinimum(uint256 amountOut, uint256 minAmountOut);
    error EmptyBatch();
    error ArrayLengthMismatch();
    error BatchTooLarge(uint256 provided, uint256 maxAllowed);
    error ReferenceIdRequired();
    error ReferenceIdTooLong(uint256 provided, uint256 maxAllowed);
    error InsufficientTokenBalance(uint256 balance, uint256 amount);

    // Address of the FX Engine (can be StableFX, Uniswap, or any DEX)
    IFXEngine public fxEngine;

    // Fee configuration (in basis points: 10000 = 100%)
    uint256 public feeBps;
    uint256 public constant MAX_FEE_BPS = 100; // 1% max fee
    uint256 internal constant MAX_BATCH_SIZE = 50;
    uint256 internal constant MAX_REFERENCE_ID_LENGTH = 64;
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
        if (_fxEngine == address(0)) revert FxEngineZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(_feeBps, MAX_FEE_BPS);
        
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
     * @notice Routes a single funding token into per-recipient output tokens.
     * @dev Mixed-token batch execution preserves atomicity across the full batch.
     * @param tokenIn Funding asset debited from the sender.
     * @param tokenOuts Output token to deliver for each recipient index.
     * @param recipients Recipient addresses for each batch leg.
     * @param amountsIn Input amount to route for each batch leg.
     * @param minAmountsOut Minimum acceptable output per batch leg.
     * @param referenceId Off-chain batch correlation identifier.
     * @return totalOut Aggregate output amount delivered across every batch leg.
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
        if (tokenIn == address(0)) revert TokenInZeroAddress();
        if (tokenOut == address(0)) revert TokenOutZeroAddress();
        if (amountIn == 0) revert AmountMustBeGreaterThanZero();
        if (recipient == address(0)) revert RecipientZeroAddress();

        // Check whitelist if enabled
        if (whitelistEnabled) {
            if (!whitelistedTokens[tokenIn]) revert TokenNotWhitelisted(tokenIn);
            if (!whitelistedTokens[tokenOut]) revert TokenNotWhitelisted(tokenOut);
        }

        // Pull the funding asset into the router once so the rest of the route is deterministic.
        _transferTokenFrom(tokenIn, msg.sender, address(this), amountIn);

        // The router keeps no per-payment balance sheet, so fee deduction is the only local effect.
        uint256 feeAmount = _calculateFee(amountIn);
        uint256 amountAfterFee = amountIn - feeAmount;

        if (feeAmount > 0) {
            _transferToken(tokenIn, feeCollector, feeAmount);
            emit FeeCollected(tokenIn, feeAmount);
        }

        if (tokenIn == tokenOut) {
            if (amountAfterFee < minAmountOut) {
                revert DirectTransferBelowMinimum(amountAfterFee, minAmountOut);
            }

            _transferToken(tokenOut, recipient, amountAfterFee);

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

        // Reset and re-grant approval to keep allowance management explicit for the FX engine.
        _approveToken(tokenIn, address(fxEngine), 0);
        _approveToken(tokenIn, address(fxEngine), amountAfterFee);

        // Quote enforcement remains deterministic after fees by scaling the user's floor down proportionally.
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
            // Each leg routes independently, but the enclosing transaction keeps the batch atomic.
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
        if (recipientsLength == 0) revert EmptyBatch();
        if (recipientsLength != amountsLength || recipientsLength != minAmountsLength) {
            revert ArrayLengthMismatch();
        }

        if (recipientsLength > MAX_BATCH_SIZE) {
            revert BatchTooLarge(recipientsLength, MAX_BATCH_SIZE);
        }

        uint256 referenceIdLength = bytes(referenceId).length;
        if (referenceIdLength == 0) revert ReferenceIdRequired();
        if (referenceIdLength > MAX_REFERENCE_ID_LENGTH) {
            revert ReferenceIdTooLong(referenceIdLength, MAX_REFERENCE_ID_LENGTH);
        }
    }

    function _validateBatchInputs(
        uint256 recipientsLength,
        uint256 tokenOutsLength,
        uint256 amountsLength,
        uint256 minAmountsLength,
        string memory referenceId
    ) internal pure {
        if (recipientsLength != tokenOutsLength) revert ArrayLengthMismatch();
        _validateBatchInputs(recipientsLength, amountsLength, minAmountsLength, referenceId);
    }

    function _calculateFee(uint256 amountIn) internal view returns (uint256 feeAmount) {
        if (feeBps == 0 || feeCollector == address(0)) {
            return 0;
        }

        return (amountIn * feeBps) / 10000;
    }

    /**
     * @notice Updates the downstream FX engine used for on-chain settlement.
     * @param _fxEngine New FX engine contract address.
     */
    function updateFXEngine(address _fxEngine) external onlyOwner {
        if (_fxEngine == address(0)) revert FxEngineZeroAddress();
        address oldEngine = address(fxEngine);
        fxEngine = IFXEngine(_fxEngine);
        emit FXEngineUpdated(oldEngine, _fxEngine);
    }

    /**
     * @notice Updates the fee schedule applied before routing funds.
     * @param _feeBps New fee in basis points where 100 equals 1%.
     */
    function updateFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(_feeBps, MAX_FEE_BPS);
        uint256 oldFee = feeBps;
        feeBps = _feeBps;
        emit FeeUpdated(oldFee, _feeBps);
    }

    /**
     * @notice Updates the recipient address for protocol fees.
     * @param _feeCollector New fee collector address.
     */
    function updateFeeCollector(address _feeCollector) external onlyOwner {
        address oldCollector = feeCollector;
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(oldCollector, _feeCollector);
    }

    /**
     * @notice Adds or removes a token from the routing allowlist.
     * @param token Token address to update.
     * @param status True to allow routing, false to disable routing.
     */
    function setTokenWhitelist(address token, bool status) external onlyOwner {
        if (token == address(0)) revert TokenZeroAddress();
        whitelistedTokens[token] = status;
        emit TokenWhitelisted(token, status);
    }

    /**
     * @notice Batch updates the routing allowlist.
     * @param tokens Token addresses to update.
     * @param status True to allow routing, false to disable routing.
     */
    function batchSetTokenWhitelist(address[] calldata tokens, bool status) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert TokenZeroAddress();
            whitelistedTokens[tokens[i]] = status;
            emit TokenWhitelisted(tokens[i], status);
        }
    }

    /**
     * @notice Enables or disables token allowlist enforcement.
     * @param enabled True to require allowlisted assets, false to accept any token.
     */
    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
        emit WhitelistStatusChanged(enabled);
    }

    /**
     * @notice Recovers tokens that become stranded in the router contract.
     * @param token Token address to recover.
     * @param amount Amount to recover.
     *
     * Only callable by owner. Use when tokens are sent directly to the
     * contract address without going through routeAndPay.
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert TokenZeroAddress();
        if (amount == 0) revert AmountMustBeGreaterThanZero();
        
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) revert InsufficientTokenBalance(balance, amount);
        
        _transferToken(token, owner(), amount);
        
        emit EmergencyWithdraw(token, amount, owner());
    }

    /**
     * @notice Pauses payment routing and batch execution.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Resumes payment routing and batch execution.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Estimates the recipient output for a single payment route.
     * @param tokenIn Input stablecoin address.
     * @param tokenOut Output stablecoin address.
     * @param amountIn Amount of input tokens.
     * @return estimatedAmountOut Estimated amount delivered after protocol fees.
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

    /**
     * @notice Estimates every leg of a mixed-output batch before execution.
     * @param tokenIn Shared input stablecoin.
     * @param tokenOuts Output token per recipient leg.
     * @param amountsIn Input amount per recipient leg.
     * @return estimatedAmountsOut Estimated output per batch leg.
     * @return totalEstimatedOut Sum of all estimated outputs.
     * @return totalFees Sum of all protocol fees across the batch.
     */
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
        if (tokenOuts.length != amountsIn.length) revert ArrayLengthMismatch();

        estimatedAmountsOut = new uint256[](amountsIn.length);

        for (uint256 i = 0; i < amountsIn.length; i++) {
            // Estimation mirrors execution order so off-chain reconciliation uses identical fee math.
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

    function _transferTokenFrom(address token, address from, address to, uint256 amount) private {
        if (!IERC20(token).transferFrom(from, to, amount)) {
            revert TokenTransferFromFailed(token, from, to, amount);
        }
    }

    function _transferToken(address token, address to, uint256 amount) private {
        if (!IERC20(token).transfer(to, amount)) {
            revert TokenTransferFailed(token, to, amount);
        }
    }

    function _approveToken(address token, address spender, uint256 amount) private {
        if (!IERC20(token).approve(spender, amount)) {
            revert TokenApproveFailed(token, spender, amount);
        }
    }
}
