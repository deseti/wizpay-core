// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IERC20.sol";

interface IXyloRouter {
    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address to;
        uint256 deadline;
    }

    function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut);

    function swap(SwapParams calldata params) external returns (uint256 amountOut);
}

/**
 * @title WizPaySwapExecutor
 * @notice External-wallet-only executor for XyloNet swaps.
 * @dev This contract is intentionally separate from WizPay and does not implement IFXEngine.
 */
contract WizPaySwapExecutor is Ownable, Pausable, ReentrancyGuard {
    error AmountMustBeGreaterThanZero();
    error DeadlineExpired(uint256 deadline, uint256 currentTimestamp);
    error FeeExceedsMaximum(uint256 feeBps, uint256 maxFeeBps);
    error FeeRecipientZeroAddress();
    error MinAmountOutZero();
    error RecipientZeroAddress();
    error RouterNotAllowlisted(address router);
    error RouterZeroAddress();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error TokenApproveFailed(address token, address spender, uint256 amount);
    error TokenNotAllowlisted(address token);
    error TokenTransferFailed(address token, address to, uint256 amount);
    error TokenTransferFromFailed(address token, address from, address to, uint256 amount);
    error TokenZeroAddress();

    uint256 public constant MAX_FEE_BPS = 100;

    address public feeRecipient;
    uint256 public feeBps;

    mapping(address => bool) public allowedTokens;
    mapping(address => bool) public allowedRouters;

    event WizPaySwapExecuted(
        address indexed user,
        address indexed router,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 feeAmount,
        uint256 netAmountIn,
        uint256 amountOut,
        address recipient
    );

    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeRecipientUpdated(address indexed oldFeeRecipient, address indexed newFeeRecipient);
    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event RouterAllowlistUpdated(address indexed router, bool allowed);
    event EmergencyTokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(address initialOwner, address initialFeeRecipient, uint256 initialFeeBps)
        Ownable(initialOwner)
    {
        if (initialFeeRecipient == address(0)) revert FeeRecipientZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(initialFeeBps, MAX_FEE_BPS);

        feeRecipient = initialFeeRecipient;
        feeBps = initialFeeBps;
    }

    function executeSwap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        _validateSwap(router, tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline);

        uint256 feeAmount = _calculateFee(amountIn);
        uint256 netAmountIn = amountIn - feeAmount;

        _transferTokenFrom(tokenIn, msg.sender, address(this), amountIn);

        if (feeAmount > 0) {
            _transferToken(tokenIn, feeRecipient, feeAmount);
        }

        _approveToken(tokenIn, router, 0);
        _approveToken(tokenIn, router, netAmountIn);

        amountOut = IXyloRouter(router).swap(
            IXyloRouter.SwapParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: netAmountIn,
                minAmountOut: minAmountOut,
                to: recipient,
                deadline: deadline
            })
        );

        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        emit WizPaySwapExecuted(
            msg.sender,
            router,
            tokenIn,
            tokenOut,
            amountIn,
            feeAmount,
            netAmountIn,
            amountOut,
            recipient
        );
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(newFeeBps, MAX_FEE_BPS);

        uint256 oldFeeBps = feeBps;
        feeBps = newFeeBps;

        emit FeeUpdated(oldFeeBps, newFeeBps);
    }

    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        if (newFeeRecipient == address(0)) revert FeeRecipientZeroAddress();

        address oldFeeRecipient = feeRecipient;
        feeRecipient = newFeeRecipient;

        emit FeeRecipientUpdated(oldFeeRecipient, newFeeRecipient);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert TokenZeroAddress();

        allowedTokens[token] = allowed;

        emit TokenAllowlistUpdated(token, allowed);
    }

    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert RouterZeroAddress();

        allowedRouters[router] = allowed;

        emit RouterAllowlistUpdated(router, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert TokenZeroAddress();
        if (to == address(0)) revert RecipientZeroAddress();
        if (amount == 0) revert AmountMustBeGreaterThanZero();

        _transferToken(token, to, amount);

        emit EmergencyTokenRescued(token, to, amount);
    }

    function _validateSwap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) internal view {
        if (router == address(0)) revert RouterZeroAddress();
        if (!allowedRouters[router]) revert RouterNotAllowlisted(router);
        if (tokenIn == address(0)) revert TokenZeroAddress();
        if (tokenOut == address(0)) revert TokenZeroAddress();
        if (!allowedTokens[tokenIn]) revert TokenNotAllowlisted(tokenIn);
        if (!allowedTokens[tokenOut]) revert TokenNotAllowlisted(tokenOut);
        if (amountIn == 0) revert AmountMustBeGreaterThanZero();
        if (minAmountOut == 0) revert MinAmountOutZero();
        if (recipient == address(0)) revert RecipientZeroAddress();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline, block.timestamp);
    }

    function _calculateFee(uint256 amountIn) internal view returns (uint256) {
        if (feeBps == 0) return 0;
        return (amountIn * feeBps) / 10_000;
    }

    function _transferTokenFrom(address token, address from, address to, uint256 amount) internal {
        bool success = IERC20(token).transferFrom(from, to, amount);
        if (!success) revert TokenTransferFromFailed(token, from, to, amount);
    }

    function _transferToken(address token, address to, uint256 amount) internal {
        bool success = IERC20(token).transfer(to, amount);
        if (!success) revert TokenTransferFailed(token, to, amount);
    }

    function _approveToken(address token, address spender, uint256 amount) internal {
        bool success = IERC20(token).approve(spender, amount);
        if (!success) revert TokenApproveFailed(token, spender, amount);
    }
}
