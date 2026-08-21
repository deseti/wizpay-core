// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IXyloRouterV2 {
    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address to;
        uint256 deadline;
    }

    function swap(SwapParams calldata params) external returns (uint256 amountOut);
}

/**
 * @title WizPaySwapExecutorV2
 * @notice User-funded XyloNet swap executor for Circle User-Controlled wallets.
 * @dev The caller may be an EOA or smart contract account. The executor never
 *      uses tx.origin and binds the output recipient to msg.sender. Fee settings
 *      are immutable so the deployment configuration cannot later be redirected.
 *      Allowlisted tokens cannot be rescued; pause and revoke the token first so
 *      an active user asset can never be swept by an administrator.
 */
contract WizPaySwapExecutorV2 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AmountMustBeGreaterThanZero();
    error DeadlineExpired(uint256 deadline, uint256 currentTimestamp);
    error DeadlineTooFar(uint256 deadline, uint256 maximumDeadline);
    error FeeExceedsMaximum(uint256 feeBps, uint256 maxFeeBps);
    error FeeRecipientMustEqualOwner(address feeRecipient, address owner);
    error MinAmountOutZero();
    error OwnershipLocked();
    error RecipientMustEqualCaller(address recipient, address caller);
    error RecipientZeroAddress();
    error ResidualInputBalance(uint256 expectedBalance, uint256 actualBalance);
    error RouterAmountOutMismatch(uint256 reportedAmountOut, uint256 actualAmountOut);
    error RouterNotAllowlisted(address router);
    error RouterZeroAddress();
    error SameTokenSwap();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error TokenNotAllowlisted(address token);
    error TokenRescueBlocked(address token);
    error TokenZeroAddress();

    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_DEADLINE_WINDOW = 20 minutes;

    address public immutable feeRecipient;
    uint256 public immutable feeBps;

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
    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event RouterAllowlistUpdated(address indexed router, bool allowed);
    event EmergencyTokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(address initialOwner, address initialFeeRecipient, uint256 initialFeeBps) Ownable(initialOwner) {
        if (initialFeeRecipient != initialOwner) {
            revert FeeRecipientMustEqualOwner(initialFeeRecipient, initialOwner);
        }
        if (initialFeeBps > MAX_FEE_BPS) {
            revert FeeExceedsMaximum(initialFeeBps, MAX_FEE_BPS);
        }

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

        IERC20 inputToken = IERC20(tokenIn);
        IERC20 outputToken = IERC20(tokenOut);
        uint256 startingInputBalance = inputToken.balanceOf(address(this));
        uint256 startingRecipientOutputBalance = outputToken.balanceOf(recipient);
        uint256 feeAmount = (amountIn * feeBps) / 10_000;
        uint256 netAmountIn = amountIn - feeAmount;

        inputToken.safeTransferFrom(msg.sender, address(this), amountIn);
        if (feeAmount != 0) inputToken.safeTransfer(feeRecipient, feeAmount);

        inputToken.forceApprove(router, netAmountIn);
        uint256 reportedAmountOut = IXyloRouterV2(router)
            .swap(
                IXyloRouterV2.SwapParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    amountIn: netAmountIn,
                    minAmountOut: minAmountOut,
                    to: recipient,
                    deadline: deadline
                })
            );
        inputToken.forceApprove(router, 0);

        uint256 endingInputBalance = inputToken.balanceOf(address(this));
        if (endingInputBalance != startingInputBalance) {
            revert ResidualInputBalance(startingInputBalance, endingInputBalance);
        }

        amountOut = outputToken.balanceOf(recipient) - startingRecipientOutputBalance;
        if (reportedAmountOut != amountOut) {
            revert RouterAmountOutMismatch(reportedAmountOut, amountOut);
        }
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        emit WizPaySwapExecuted(
            msg.sender, router, tokenIn, tokenOut, amountIn, feeAmount, netAmountIn, amountOut, recipient
        );
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

    function transferOwnership(address) public pure override {
        revert OwnershipLocked();
    }

    function renounceOwnership() public pure override {
        revert OwnershipLocked();
    }

    /**
     * @notice Recovers only non-active assets while swaps are paused.
     * @dev Revoke an accidentally configured token before rescue. User swaps
     *      are atomic, so a successful execution cannot leave user input here.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner whenPaused {
        if (token == address(0)) revert TokenZeroAddress();
        if (to == address(0)) revert RecipientZeroAddress();
        if (amount == 0) revert AmountMustBeGreaterThanZero();
        if (allowedTokens[token]) revert TokenRescueBlocked(token);

        IERC20(token).safeTransfer(to, amount);
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
        if (tokenIn == address(0) || tokenOut == address(0)) revert TokenZeroAddress();
        if (tokenIn == tokenOut) revert SameTokenSwap();
        if (!allowedTokens[tokenIn]) revert TokenNotAllowlisted(tokenIn);
        if (!allowedTokens[tokenOut]) revert TokenNotAllowlisted(tokenOut);
        if (amountIn == 0) revert AmountMustBeGreaterThanZero();
        if (minAmountOut == 0) revert MinAmountOutZero();
        if (recipient == address(0)) revert RecipientZeroAddress();
        if (recipient != msg.sender) revert RecipientMustEqualCaller(recipient, msg.sender);
        if (deadline < block.timestamp) revert DeadlineExpired(deadline, block.timestamp);

        uint256 maximumDeadline = block.timestamp + MAX_DEADLINE_WINDOW;
        if (deadline > maximumDeadline) revert DeadlineTooFar(deadline, maximumDeadline);
    }
}
