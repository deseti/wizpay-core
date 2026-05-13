// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IFXEngine.sol";

/**
 * @title StableFXBridge
 * @dev Minimal IFXEngine implementation that acts as a pass-through for the Payment_Router,
 * delegating actual FX execution to the off-chain Circle StableFX RFQ infrastructure.
 *
 * Supports a pre-funded mode where the orchestrator deposits output tokens before swap()
 * is called, allowing atomic same-transaction compatibility with the Payment_Router.
 *
 * Design constraints (ERC-4337 compatibility):
 * - No banned opcodes: SELFDESTRUCT, CREATE, CREATE2, GASPRICE, BASEFEE, ORIGIN
 * - No callback mechanisms to calling contract
 * - No external calls to user-derived addresses beyond tokenIn/tokenOut
 */
contract StableFXBridge is IFXEngine {
    // ─── Errors ──────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotOwner();
    error NotOrchestrator();
    error TokenNotSupported(address token);
    error AmountMustBeGreaterThanZero();
    error InsufficientPreFundedBalance(uint256 available, uint256 required);
    error TokenTransferFailed(address token, address to, uint256 amount);
    error TokenTransferFromFailed(address token, address from, address to, uint256 amount);
    error SwapNotPending(bytes32 swapId);
    error NoPreFundedBalance();

    // ─── Events ──────────────────────────────────────────────────────────────────

    event SwapInitiated(
        bytes32 indexed swapId,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    );

    event SwapCompleted(
        bytes32 indexed swapId,
        address indexed tokenOut,
        uint256 amountOut,
        address indexed to
    );

    event PreFunded(
        address indexed recipient,
        address indexed token,
        uint256 amount
    );

    event OrchestratorUpdated(
        address indexed previousOrchestrator,
        address indexed newOrchestrator
    );

    // ─── Structs ─────────────────────────────────────────────────────────────────

    struct PendingSwap {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address to;
        bool exists;
    }

    // ─── Storage ─────────────────────────────────────────────────────────────────

    address public owner;
    address public orchestrator;

    /// @notice Tokens supported by this bridge (USDC, EURC)
    mapping(address => bool) public supportedTokens;

    /// @notice Pending swaps awaiting async settlement (swapId => PendingSwap)
    mapping(bytes32 => PendingSwap) public pendingSwaps;

    /// @notice Pre-funded output balances deposited by orchestrator (recipient => token => amount)
    mapping(address => mapping(address => uint256)) public preFundedBalances;

    /// @notice Nonce for generating unique swap IDs
    uint256 private _swapNonce;

    // ─── Modifiers ───────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOrchestrator() {
        if (msg.sender != orchestrator) revert NotOrchestrator();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the StableFXBridge with initial configuration.
     * @param _owner Address that can manage the bridge (update orchestrator, etc.)
     * @param _orchestrator Address of the off-chain orchestrator that pre-funds and completes swaps
     * @param _usdc Address of the USDC token contract
     * @param _eurc Address of the EURC token contract
     */
    constructor(
        address _owner,
        address _orchestrator,
        address _usdc,
        address _eurc
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        if (_orchestrator == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_eurc == address(0)) revert ZeroAddress();

        owner = _owner;
        orchestrator = _orchestrator;
        supportedTokens[_usdc] = true;
        supportedTokens[_eurc] = true;
    }

    // ─── IFXEngine Interface ─────────────────────────────────────────────────────

    /**
     * @notice Executes a swap using pre-funded output tokens.
     * @dev In pre-funded mode, the orchestrator has already deposited tokenOut for the
     * recipient. This function validates the pre-funded balance, transfers tokenIn from
     * the caller to this contract, and transfers the pre-funded tokenOut to the recipient.
     *
     * No banned ERC-4337 opcodes. No callbacks. No external calls beyond tokenIn/tokenOut.
     *
     * @param tokenIn Address of the input token
     * @param tokenOut Address of the output token
     * @param amountIn Amount of input tokens to swap
     * @param minAmountOut Minimum acceptable output amount (slippage protection)
     * @param to Recipient address for output tokens
     * @return amountOut The actual amount of output tokens sent to recipient
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external override returns (uint256 amountOut) {
        // Validate tokens are supported
        if (!supportedTokens[tokenIn]) revert TokenNotSupported(tokenIn);
        if (!supportedTokens[tokenOut]) revert TokenNotSupported(tokenOut);

        // Validate amountIn > 0
        if (amountIn == 0) revert AmountMustBeGreaterThanZero();

        // Check pre-funded balance for recipient
        uint256 available = preFundedBalances[to][tokenOut];
        if (available < minAmountOut) {
            revert InsufficientPreFundedBalance(available, minAmountOut);
        }

        // Determine amountOut: use the full pre-funded amount up to what's available
        // Cap at available balance (the orchestrator pre-funded exactly what's needed)
        amountOut = available;

        // Transfer tokenIn from caller (Payment_Router) to this contract
        if (!IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn)) {
            revert TokenTransferFromFailed(tokenIn, msg.sender, address(this), amountIn);
        }

        // Deduct from pre-funded balances before transfer (checks-effects-interactions)
        preFundedBalances[to][tokenOut] = 0;

        // Transfer pre-funded tokenOut to recipient
        if (!IERC20(tokenOut).transfer(to, amountOut)) {
            revert TokenTransferFailed(tokenOut, to, amountOut);
        }

        // Generate swap ID for event correlation
        bytes32 swapId = _generateSwapId();

        // Emit SwapCompleted event
        emit SwapCompleted(swapId, tokenOut, amountOut, to);

        return amountOut;
    }

    /**
     * @notice Returns the estimated output amount based on pre-funded balances.
     * @dev Since this is a pre-funded bridge, the "estimate" is the actual pre-funded
     * balance available. The function uses a deterministic lookup based on the contract's
     * own address as a proxy for the recipient context (the Payment_Router calls this
     * before knowing the final recipient). Returns the amountIn as the estimate when
     * tokens are supported (1:1 pass-through assumption for estimation purposes),
     * or reverts if no pre-funding mechanism is available for the pair.
     *
     * @param tokenIn Address of the input token
     * @param tokenOut Address of the output token
     * @param amountIn Amount of input tokens
     * @return estimatedAmountOut The estimated output amount
     */
    function getEstimatedAmount(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view override returns (uint256 estimatedAmountOut) {
        // Validate tokens are supported
        if (!supportedTokens[tokenIn]) revert TokenNotSupported(tokenIn);
        if (!supportedTokens[tokenOut]) revert TokenNotSupported(tokenOut);

        // For estimation purposes, return amountIn as the estimate.
        // The actual output depends on the pre-funded balance at swap time.
        // This provides a reasonable estimate for the Payment_Router's
        // getEstimatedOutput view function without requiring recipient context.
        return amountIn;
    }

    // ─── Orchestrator Functions ──────────────────────────────────────────────────

    /**
     * @notice Pre-funds output tokens for a specific recipient.
     * @dev Called by the orchestrator after completing the off-chain RFQ flow.
     * Transfers tokens from the orchestrator to this contract and records the
     * balance for the recipient to claim during swap().
     *
     * @param recipient Address that will receive the tokens during swap()
     * @param token Address of the token being pre-funded
     * @param amount Amount of tokens to pre-fund
     */
    function preFund(
        address recipient,
        address token,
        uint256 amount
    ) external onlyOrchestrator {
        if (recipient == address(0)) revert ZeroAddress();
        if (!supportedTokens[token]) revert TokenNotSupported(token);
        if (amount == 0) revert AmountMustBeGreaterThanZero();

        // Transfer tokens from orchestrator to this contract
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) {
            revert TokenTransferFromFailed(token, msg.sender, address(this), amount);
        }

        // Record pre-funded balance for recipient
        preFundedBalances[recipient][token] += amount;

        emit PreFunded(recipient, token, amount);
    }

    /**
     * @notice Completes an async swap that was previously initiated.
     * @dev Called by the orchestrator after the off-chain settlement confirms.
     * Looks up the pending swap, transfers tokenOut to the recipient,
     * and cleans up the pending swap record.
     *
     * @param swapId The unique identifier of the pending swap to complete
     */
    function completeSwap(bytes32 swapId) external onlyOrchestrator {
        PendingSwap storage pending = pendingSwaps[swapId];
        if (!pending.exists) revert SwapNotPending(swapId);

        address tokenOut = pending.tokenOut;
        uint256 minAmountOut = pending.minAmountOut;
        address to = pending.to;

        // Determine output amount from pre-funded balance
        uint256 available = preFundedBalances[to][tokenOut];
        if (available < minAmountOut) {
            revert InsufficientPreFundedBalance(available, minAmountOut);
        }

        uint256 amountOut = available;

        // Clear pending swap before external calls (checks-effects-interactions)
        delete pendingSwaps[swapId];

        // Deduct pre-funded balance
        preFundedBalances[to][tokenOut] = 0;

        // Transfer tokenOut to recipient
        if (!IERC20(tokenOut).transfer(to, amountOut)) {
            revert TokenTransferFailed(tokenOut, to, amountOut);
        }

        emit SwapCompleted(swapId, tokenOut, amountOut, to);
    }

    // ─── Admin Functions ─────────────────────────────────────────────────────────

    /**
     * @notice Updates the orchestrator address.
     * @param _orchestrator New orchestrator address
     */
    function updateOrchestrator(address _orchestrator) external onlyOwner {
        if (_orchestrator == address(0)) revert ZeroAddress();
        address previous = orchestrator;
        orchestrator = _orchestrator;
        emit OrchestratorUpdated(previous, _orchestrator);
    }

    // ─── Internal Functions ──────────────────────────────────────────────────────

    /**
     * @dev Generates a unique swap ID using the nonce.
     * Uses keccak256 with block context and nonce for uniqueness.
     * No banned opcodes (no GASPRICE, BASEFEE, ORIGIN).
     */
    function _generateSwapId() private returns (bytes32) {
        _swapNonce++;
        return keccak256(abi.encodePacked(block.number, block.timestamp, _swapNonce));
    }
}
