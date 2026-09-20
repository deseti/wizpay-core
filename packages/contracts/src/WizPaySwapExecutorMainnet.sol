// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

// ---------------------------------------------------------------------------
// External interfaces
// ---------------------------------------------------------------------------

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev Subset of the canonical Permit2 interface used by this contract.
///      Full Permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

// ---------------------------------------------------------------------------
// WizPaySwapExecutorMainnet
// ---------------------------------------------------------------------------

/**
 * @title  WizPaySwapExecutorMainnet
 * @notice Arc Mainnet USDC<->EURC single-hop Uniswap V4 swap executor.
 *         executable=false until authorization.
 *
 * USDC -> EURC (native-only, no ERC-20 approval):
 *   Caller sends msg.value = amountIn * ARC_NATIVE_USDC_SCALE.
 *   Executor splits native USDC: fee -> feeRecipient, net -> UniversalRouter.
 *   SETTLE payerIsUser=false: _mapPayer(false) = router, pays from msg.value.
 *   User pays exactly gross amountIn once. No double charge.
 *
 * EURC -> USDC (ERC-20 via Permit2):
 *   Caller approves executor for amountIn EURC. msg.value = 0.
 *   Executor pulls gross, splits fee, holds net EURC.
 *   Sets EURC.forceApprove(Permit2, net) + Permit2.approve(EURC, router, net).
 *   SETTLE payerIsUser=true: _mapPayer(true) = msgSender() = executor.
 *   Router uses Permit2 to pull EURC from executor. Both allowances cleared after.
 *
 * V4 ENCODING (proven by Arc Mainnet bidirectional evidence):
 *   commands : 0x10              (V4_SWAP)
 *   actions  : 0x07 0x0b 0x0e   (SWAP_EXACT_IN, SETTLE, TAKE)
 *   Incorrect draft 0x06/0x14/0x0f is NOT used.
 */
contract WizPaySwapExecutorMainnet is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AmountMustBeGreaterThanZero();
    error AmountInExceedsUint128(uint256 amountIn);
    error InitialOwnerMustBeContract(address owner);
    error InvalidPoolFee(uint24 provided);
    error InvalidPoolTickSpacing(int24 provided);
    error MinAmountOutExceedsUint128(uint256 minAmountOut);
    error ResourceHasNoCode(address resource);
    error WrongChain(uint256 actualChainId);
    error DeadlineExpired(uint256 deadline, uint256 currentTimestamp);
    error DeadlineTooFar(uint256 deadline, uint256 maximumDeadline);
    error FeeExceedsMaximum(uint256 feeBps, uint256 maxFeeBps);
    error FeeRecipientMustEqualOwner(address feeRecipient, address owner);
    error MinAmountOutZero();
    error MinHopPriceX36Zero();
    error NativeMsgValueMismatch(uint256 sent, uint256 expected);
    error NativeTransferFailed();
    error OwnershipLocked();
    error RecipientZeroAddress();
    error ResidualInputBalance(uint256 expectedBalance, uint256 actualBalance);
    error ResidualNativeBalance(uint256 expectedBalance, uint256 actualBalance);
    error ResidualOutputBalance(uint256 expectedBalance, uint256 actualBalance);
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error TokenRescueBlocked(address token);
    error UnsupportedSwapPair(address tokenIn, address tokenOut);

    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct ExactInputSingleParams {
        address currencyIn;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_DEADLINE_WINDOW = 20 minutes;
    uint256 public constant ARC_NATIVE_USDC_SCALE = 1_000_000_000_000;
    uint256 public constant ARC_MAINNET_CHAIN_ID = 5_042;
    uint24 public constant ARC_MAINNET_POOL_FEE = 500;
    int24 public constant ARC_MAINNET_POOL_TICK_SPACING = 10;

    uint8 internal constant _CMD_V4_SWAP = 0x10;
    uint8 internal constant _ACTION_SWAP_EXACT_IN = 0x07;
    uint8 internal constant _ACTION_SETTLE = 0x0b;
    uint8 internal constant _ACTION_TAKE = 0x0e;

    // -----------------------------------------------------------------------
    // Immutables
    // -----------------------------------------------------------------------

    address public immutable USDC;
    address public immutable EURC;
    IUniversalRouter public immutable universalRouter;
    IPermit2 public immutable permit2;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;
    address public immutable feeRecipient;
    uint256 public immutable feeBps;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event WizPayMainnetSwapExecuted(
        address indexed caller,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 feeAmount,
        uint256 netAmountIn,
        uint256 amountOut,
        uint256 minAmountOut
    );

    event EmergencyTokenRescued(address indexed token, address indexed to, uint256 amount);

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(
        address initialOwner,
        address initialFeeRecipient,
        uint256 initialFeeBps,
        address usdc_,
        address eurc_,
        address universalRouter_,
        address permit2_,
        uint24 fee_,
        int24 tickSpacing_
    ) Ownable(initialOwner) {
        if (initialFeeRecipient != initialOwner) {
            revert FeeRecipientMustEqualOwner(initialFeeRecipient, initialOwner);
        }
        if (initialFeeBps > MAX_FEE_BPS) {
            revert FeeExceedsMaximum(initialFeeBps, MAX_FEE_BPS);
        }
        if (block.chainid != ARC_MAINNET_CHAIN_ID) {
            revert WrongChain(block.chainid);
        }
        if (initialOwner.code.length == 0) {
            revert InitialOwnerMustBeContract(initialOwner);
        }
        require(usdc_ != address(0) && eurc_ != address(0) && usdc_ != eurc_, "bad tokens");
        require(universalRouter_ != address(0) && permit2_ != address(0), "bad infra");

        if (usdc_.code.length == 0) revert ResourceHasNoCode(usdc_);
        if (eurc_.code.length == 0) revert ResourceHasNoCode(eurc_);
        if (universalRouter_.code.length == 0) revert ResourceHasNoCode(universalRouter_);
        if (permit2_.code.length == 0) revert ResourceHasNoCode(permit2_);

        if (fee_ != ARC_MAINNET_POOL_FEE) {
            revert InvalidPoolFee(fee_);
        }
        if (tickSpacing_ != ARC_MAINNET_POOL_TICK_SPACING) {
            revert InvalidPoolTickSpacing(tickSpacing_);
        }

        USDC = usdc_;
        EURC = eurc_;
        universalRouter = IUniversalRouter(universalRouter_);
        permit2 = IPermit2(permit2_);
        poolFee = fee_;
        poolTickSpacing = tickSpacing_;
        feeRecipient = initialFeeRecipient;
        feeBps = initialFeeBps;

        // Deployment never implies activation. The authorized Safe must
        // explicitly unpause only after post-deployment verification.
        _pause();
    }

    // -----------------------------------------------------------------------
    // External: swap entry point
    // -----------------------------------------------------------------------

    /**
     * @notice Execute a USDC->EURC or EURC->USDC swap.
     *
     * USDC input:
     *   Send msg.value == amountIn * ARC_NATIVE_USDC_SCALE.
     *   No ERC-20 approval required.
     *
     * EURC input:
     *   Approve this contract for amountIn EURC before calling.
     *   Send msg.value == 0.
     */
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 minHopPriceX36,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        _validateSwap(tokenIn, tokenOut, amountIn, minAmountOut, minHopPriceX36, deadline);

        bool usdcIn = tokenIn == USDC;
        uint256 feeAmount = feeBps == 0 ? 0 : (amountIn * feeBps) / 10_000;
        uint256 netAmountIn = amountIn - feeAmount;

        IERC20 outputToken = IERC20(tokenOut);
        uint256 startOutputBal = outputToken.balanceOf(address(this));
        uint256 startRecipientOut = outputToken.balanceOf(msg.sender);

        if (usdcIn) {
            amountOut = _executeUsdcSwap(
                tokenIn,
                tokenOut,
                amountIn,
                netAmountIn,
                feeAmount,
                minAmountOut,
                minHopPriceX36,
                deadline,
                startOutputBal
            );
        } else {
            amountOut = _executeEurcSwap(
                tokenIn,
                tokenOut,
                amountIn,
                netAmountIn,
                feeAmount,
                minAmountOut,
                minHopPriceX36,
                deadline,
                startOutputBal
            );
        }

        // ── Shared: residual output check ─────────────────────────────────
        {
            uint256 endOutputBal = outputToken.balanceOf(address(this));
            if (endOutputBal != startOutputBal) revert ResidualOutputBalance(startOutputBal, endOutputBal);
        }

        // ── Shared: slippage check ────────────────────────────────────────
        amountOut = outputToken.balanceOf(msg.sender) - startRecipientOut;
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        emit WizPayMainnetSwapExecuted(
            msg.sender, tokenIn, tokenOut, amountIn, feeAmount, netAmountIn, amountOut, minAmountOut
        );
    }

    // -----------------------------------------------------------------------
    // Internal: USDC -> EURC (native-only)
    // -----------------------------------------------------------------------

    function _executeUsdcSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 netAmountIn,
        uint256 feeAmount,
        uint256 minAmountOut,
        uint256 minHopPriceX36,
        uint256 deadline,
        uint256 /*startOutputBal*/
    ) internal returns (uint256) {
        // Caller sends gross amountIn as native USDC. No ERC-20 transfer.
        uint256 expectedNative = amountIn * ARC_NATIVE_USDC_SCALE;
        if (msg.value != expectedNative) {
            revert NativeMsgValueMismatch(msg.value, expectedNative);
        }

        // Snapshot native balance before disbursement (includes msg.value).
        uint256 priorNativeBal = address(this).balance - msg.value;

        // Send fee as native USDC to feeRecipient.
        if (feeAmount != 0) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = payable(feeRecipient).call{value: feeAmount * ARC_NATIVE_USDC_SCALE}("");
            if (!ok) revert NativeTransferFailed();
        }

        // Forward net native USDC to the router.
        // SETTLE payerIsUser=false: _mapPayer(false) = router (address(this)).
        // Router pays PoolManager from its own received native balance.
        uint256 netNative = netAmountIn * ARC_NATIVE_USDC_SCALE;
        {
            bytes memory commands = abi.encodePacked(_CMD_V4_SWAP);
            bytes[] memory inputs = new bytes[](1);
            inputs[0] =
                _buildV4SwapInput(tokenIn, tokenOut, netAmountIn, minAmountOut, minHopPriceX36, msg.sender, false);
            // slither-disable-next-line arbitrary-send-eth
            universalRouter.execute{value: netNative}(commands, inputs, deadline);
        }

        // Residual native check: all received native must be disbursed.
        // fee + net = amountIn = msg.value, so balance must return to priorNativeBal.
        uint256 endNativeBal = address(this).balance;
        if (endNativeBal != priorNativeBal) {
            revert ResidualNativeBalance(priorNativeBal, endNativeBal);
        }

        return 0; // amountOut computed by caller from recipient balance delta
    }

    // -----------------------------------------------------------------------
    // Internal: EURC -> USDC (ERC-20 via Permit2)
    // -----------------------------------------------------------------------

    function _executeEurcSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 netAmountIn,
        uint256 feeAmount,
        uint256 minAmountOut,
        uint256 minHopPriceX36,
        uint256 deadline,
        uint256 /*startOutputBal*/
    ) internal returns (uint256) {
        if (msg.value != 0) revert NativeMsgValueMismatch(msg.value, 0);

        IERC20 inputToken = IERC20(tokenIn);
        uint256 startInputBal = inputToken.balanceOf(address(this));

        // Pull gross EURC from caller.
        inputToken.safeTransferFrom(msg.sender, address(this), amountIn);

        // Split fee.
        if (feeAmount != 0) {
            inputToken.safeTransfer(feeRecipient, feeAmount);
        }
        // Executor holds exactly netAmountIn EURC.

        // Set allowances for Permit2-mediated pull.
        // payerIsUser=true: _mapPayer(true) = msgSender() = executor.
        // Router calls payOrPermit2Transfer -> Permit2 pulls EURC from executor.
        inputToken.forceApprove(address(permit2), netAmountIn);
        uint48 expiry = (deadline + 1).toUint48();
        permit2.approve(tokenIn, address(universalRouter), netAmountIn.toUint160(), expiry);

        // Call router.
        {
            bytes memory commands = abi.encodePacked(_CMD_V4_SWAP);
            bytes[] memory inputs = new bytes[](1);
            inputs[0] =
                _buildV4SwapInput(tokenIn, tokenOut, netAmountIn, minAmountOut, minHopPriceX36, msg.sender, true);
            // slither-disable-next-line arbitrary-send-eth
            universalRouter.execute{value: 0}(commands, inputs, deadline);
        }

        // Clear both allowances.
        inputToken.forceApprove(address(permit2), 0);
        permit2.approve(tokenIn, address(universalRouter), 0, 0);

        // Residual input check.
        uint256 endInputBal = inputToken.balanceOf(address(this));
        if (endInputBal != startInputBal) {
            revert ResidualInputBalance(startInputBal, endInputBal);
        }

        return 0; // amountOut computed by caller from recipient balance delta
    }

    // -----------------------------------------------------------------------
    // Administration
    // -----------------------------------------------------------------------

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

    function rescueTokens(address token, address to, uint256 amount) external onlyOwner whenPaused {
        if (to == address(0)) revert RecipientZeroAddress();
        if (amount == 0) revert AmountMustBeGreaterThanZero();
        if (token == USDC || token == EURC) revert TokenRescueBlocked(token);
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyTokenRescued(token, to, amount);
    }

    // -----------------------------------------------------------------------
    // Internal validation
    // -----------------------------------------------------------------------

    function _validateSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 minHopPriceX36,
        uint256 deadline
    ) internal view {
        bool validPair =
            (tokenIn == USDC && tokenOut == EURC) || (tokenIn == EURC && tokenOut == USDC);
        if (!validPair) revert UnsupportedSwapPair(tokenIn, tokenOut);
        if (amountIn == 0) revert AmountMustBeGreaterThanZero();
        if (amountIn > type(uint128).max) revert AmountInExceedsUint128(amountIn);
        if (minAmountOut == 0) revert MinAmountOutZero();
        if (minAmountOut > type(uint128).max) {
            revert MinAmountOutExceedsUint128(minAmountOut);
        }
        if (minHopPriceX36 == 0) revert MinHopPriceX36Zero();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline, block.timestamp);
        uint256 maxDeadline = block.timestamp + MAX_DEADLINE_WINDOW;
        if (deadline > maxDeadline) revert DeadlineTooFar(deadline, maxDeadline);
    }

    // -----------------------------------------------------------------------
    // Payload construction
    // -----------------------------------------------------------------------

    function _buildV4SwapInput(
        address tokenIn,
        address tokenOut,
        uint256 netAmountIn,
        uint256 minAmountOut,
        uint256 minHopPriceX36,
        address recipient,
        bool payerIsUser
    ) private view returns (bytes memory) {
        bytes memory actions = abi.encodePacked(_ACTION_SWAP_EXACT_IN, _ACTION_SETTLE, _ACTION_TAKE);

        PathKey[] memory path = new PathKey[](1);
        path[0] = PathKey({
            intermediateCurrency: tokenOut, fee: poolFee, tickSpacing: poolTickSpacing, hooks: address(0), hookData: ""
        });

        uint256[] memory hopPrices = new uint256[](1);
        hopPrices[0] = minHopPriceX36;

        bytes[] memory params = new bytes[](3);

        params[0] = abi.encode(
            ExactInputSingleParams({
                currencyIn: tokenIn,
                path: path,
                minHopPriceX36: hopPrices,
                amountIn: netAmountIn.toUint128(),
                amountOutMinimum: minAmountOut.toUint128()
            })
        );

        // SETTLE: payerIsUser=false for USDC (router pays from its received msg.value).
        //         payerIsUser=true  for EURC (executor is payer via Permit2).
        params[1] = abi.encode(tokenIn, uint256(0), payerIsUser);

        // TAKE: output goes to the original executeSwap caller.
        params[2] = abi.encode(tokenOut, recipient, uint256(0));

        return abi.encode(actions, params);
    }

    // -----------------------------------------------------------------------
    // View helpers (for tests and off-chain tooling)
    // -----------------------------------------------------------------------

    function expectedActions() external pure returns (bytes memory) {
        return abi.encodePacked(_ACTION_SWAP_EXACT_IN, _ACTION_SETTLE, _ACTION_TAKE);
    }

    function expectedCommands() external pure returns (bytes memory) {
        return abi.encodePacked(_CMD_V4_SWAP);
    }
}
