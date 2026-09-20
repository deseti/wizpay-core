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

    function poolManager() external view returns (address);
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
// WizPayPayrollMainnet
// ---------------------------------------------------------------------------

/**
 * @title  WizPayPayrollMainnet
 * @notice Arc Mainnet only atomic batch payroll with same-token distribution
 *         and single aggregate Uniswap V4 swap for cross-token payroll.
 *         executable=false until authorization. Born paused.
 *
 * Architecture (Step 8, composition model B):
 *   External Employer Wallet / Safe -> WizPayPayrollMainnet
 *   Same-token:  -> atomic batch distribution (no Uniswap call).
 *   Cross-token: -> approved Uniswap V4 route -> aggregate swap
 *                -> atomic batch distribution.
 *
 * Composition decision (B: internal V4 component, NOT composing
 * WizPaySwapExecutorMainnet):
 *   - Atomicity: single transaction owns swap + distribution; no nested
 *     pause/reentrancy coupling across two payroll-aware contracts.
 *   - Recipient semantics: Step 7 TAKEs to a single msg.sender. Payroll needs
 *     TAKE to itself followed by batch fan-out. Internal TAKE avoids an extra
 *     executor->payroll hop.
 *   - EURC allowance: single hop employer->payroll->Permit2->router instead of
 *     employer->executor->Permit2->router double approval chain.
 *   - Native USDC: single native receipt/forward (payroll->router) instead of
 *     payroll->executor->router double native forwarding.
 *   - Residual accounting: single balance domain (payroll) instead of split
 *     executor + payroll residual domains.
 *   - Pause: only payroll pause gates execution; no dual-pause failure mode.
 *   - Fee: ONE explicit immutable payroll fee. Composing the executor would
 *     risk a silent double fee (payroll fee + executor swap fee).
 *   - Gas: one router call, not payroll->executor->router.
 *   - Replay: payroll owns the reference; executor has none.
 * No incompatibility in WizPaySwapExecutorMainnet was proven, so it is NOT
 * modified. The proven V4 encoding (commands 0x10, actions 0x07/0x0b/0x0e,
 * single-hop PathKey, ExactInputSingleParams, SETTLE/TAKE) is reused with
 * TAKE recipient = address(this).
 *
 * Fee model (single, explicit, immutable):
 *   feeBps is immutable, 0..100, feeRecipient == owner (Safe).
 *   Fee is charged exactly ONCE, always paid by the employer ON TOP of
 *   exact recipient obligations:
 *   - Same-token: amounts[] are exact obligations; recipients receive
 *     exactly amounts[i]. totalFunding = sum(amounts) + sum(fee(amounts[i]))
 *     is pulled from the employer; totalFees goes to the Safe.
 *   - Cross-token: outputAmounts[] are exact obligations in the output
 *     token; aggregate fee = grossInput * feeBps / 10_000 in the input
 *     token (native USDC or EURC), net swapped. Swap output pays output
 *     obligations; surplus refunded to employer in the output token.
 *   There is no output fee, no executor fee, no treasury/dev liquidity.
 *   Zero fee (feeBps=0) is supported.
 *
 * Funding mechanics:
 *   - Same-token USDC->USDC and EURC->EURC: ERC-20 only, msg.value must be 0.
 *     No Uniswap call. Exact funding check prevents fee-on-transfer abuse and
 *     prevents pre-existing balances from subsidizing payroll.
 *   - Cross-token USDC->EURC: native-only input. msg.value must equal
 *     grossInput * ARC_NATIVE_USDC_SCALE. No ERC-20 approval. Fee split in
 *     native; net forwarded to UniversalRouter; SETTLE payerIsUser=false.
 *     Residual accounting is ResidualNativeBalance. Do not apply
 *     IERC20(USDC).balanceOf as an ERC-20 residual: on Arc, native USDC and
 *     the canonical USDC ERC-20 balance are coupled, so msg.value is already
 *     visible in that reading.
 *   - Cross-token EURC->USDC: ERC-20 via Permit2. msg.value must be 0.
 *     Pull gross, split fee, hold net, approve Permit2 + router, swap with
 *     SETTLE payerIsUser=true, clear both allowances.
 *
 * V4 ENCODING (reused from Step 7, proven by Arc Mainnet evidence):
 *   commands : 0x10              (V4_SWAP)
 *   actions  : 0x07 0x0b 0x0e   (SWAP_EXACT_IN, SETTLE, TAKE)
 */
contract WizPayPayrollMainnet is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AmountMustBeGreaterThanZero();
    error AmountInExceedsUint128(uint256 amountIn);
    error ArrayLengthMismatch();
    error BatchTooLarge(uint256 provided, uint256 maxAllowed);
    error ContractRecipientNotAllowed(address recipient);
    error DeadlineExpired(uint256 deadline, uint256 currentTimestamp);
    error DeadlineTooFar(uint256 deadline, uint256 maximumDeadline);
    error EmptyBatch();
    error FeeExceedsMaximum(uint256 feeBps, uint256 maxFeeBps);
    error FeeRecipientMustEqualOwner(address feeRecipient, address owner);
    error InitialOwnerMustBeContract(address owner);
    error InsufficientSwapOutput(uint256 actualOutput, uint256 requiredOutput);
    error InvalidPoolFee(uint24 provided);
    error InvalidPoolTickSpacing(int24 provided);
    error MinAmountOutExceedsUint128(uint256 minAmountOut);
    error MinHopPriceX36Zero();
    error MinTotalOutBelowObligations(uint256 minTotalOut, uint256 totalObligations);
    error MinTotalOutZero();
    error NativeMsgValueMismatch(uint256 sent, uint256 expected);
    error NativeTransferFailed();
    error OwnershipLocked();
    error RecipientZeroAddress();
    error ReferenceAlreadyUsed(bytes32 referenceHash);
    error ReferenceIdRequired();
    error ReferenceIdTooLong(uint256 provided, uint256 maxAllowed);
    error ResidualInputBalance(uint256 expectedBalance, uint256 actualBalance);
    error ResidualNativeBalance(uint256 expectedBalance, uint256 actualBalance);
    error ResidualOutputBalance(uint256 expectedBalance, uint256 actualBalance);
    error ResourceHasNoCode(address resource);
    error RouterPoolManagerMismatch(address expectedPoolManager, address actualPoolManager);
    error SelfPaymentNotAllowed(address employer);
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error TokenRescueBlocked(address token);
    error UnsupportedPayrollPair(address tokenIn, address tokenOut);
    error WrongChain(uint256 actualChainId);

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
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant MAX_REFERENCE_ID_LENGTH = 64;
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
    address public immutable poolManager;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;
    address public immutable feeRecipient;
    uint256 public immutable feeBps;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    mapping(bytes32 => bool) public usedReferenceHashes;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event PayrollPayment(
        bytes32 indexed referenceHash,
        address indexed employer,
        address indexed tokenOut,
        address recipient,
        uint256 paymentIndex,
        uint256 amountOut
    );

    event PayrollReferenceConsumed(
        bytes32 indexed referenceHash,
        address indexed employer,
        address indexed tokenIn,
        address tokenOut,
        bytes32 batchDigest,
        uint256 totalInput,
        uint256 totalOutput,
        uint256 totalFees,
        uint256 recipientCount,
        string referenceId
    );

    event PayrollBatchExecuted(
        address indexed employer,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 totalInput,
        uint256 totalOutput,
        uint256 totalFees,
        uint256 recipientCount,
        string referenceId
    );

    event PayrollSwapExecuted(
        bytes32 indexed referenceHash,
        address indexed employer,
        address indexed tokenIn,
        address tokenOut,
        uint256 grossInput,
        uint256 feeAmount,
        uint256 netAmountIn,
        uint256 amountOut,
        uint256 minTotalOut
    );

    event PayrollSurplusRefunded(
        bytes32 indexed referenceHash, address indexed employer, address indexed tokenOut, uint256 amount
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
        address poolManager_,
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
        require(universalRouter_ != address(0) && permit2_ != address(0) && poolManager_ != address(0), "bad infra");

        if (usdc_.code.length == 0) revert ResourceHasNoCode(usdc_);
        if (eurc_.code.length == 0) revert ResourceHasNoCode(eurc_);
        if (universalRouter_.code.length == 0) revert ResourceHasNoCode(universalRouter_);
        if (permit2_.code.length == 0) revert ResourceHasNoCode(permit2_);
        if (poolManager_.code.length == 0) revert ResourceHasNoCode(poolManager_);

        address reportedPoolManager = IUniversalRouter(universalRouter_).poolManager();
        if (reportedPoolManager != poolManager_) {
            revert RouterPoolManagerMismatch(poolManager_, reportedPoolManager);
        }

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
        poolManager = poolManager_;
        poolFee = fee_;
        poolTickSpacing = tickSpacing_;
        feeRecipient = initialFeeRecipient;
        feeBps = initialFeeBps;

        // Deployment never implies activation. The authorized Safe must
        // explicitly unpause only after post-deployment verification.
        _pause();
    }

    // -----------------------------------------------------------------------
    // View: deterministic reference / batch digests
    // -----------------------------------------------------------------------

    /**
     * @notice Global replay key. Binds chain, contract, employer and the
     * caller-supplied reference id ONLY. Token pair and payroll details are
     * intentionally NOT part of the replay key: a consumed referenceId for an
     * employer is unusable again for ANY payroll route. Amounts/recipients
     * are also excluded so a reused reference id always reverts, even with
     * different amounts (prevents duplicate-reference confusion).
     */
    function canonicalReferenceHash(address employer, string calldata referenceId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), employer, referenceId));
    }

    /**
     * @notice Batch digest. Binds chain, contract, employer, token pair,
     * recipients (order-sensitive), amounts, fee parameters and reference id.
     */
    function canonicalBatchDigest(
        address employer,
        address tokenIn,
        address tokenOut,
        address[] calldata recipients,
        uint256[] calldata amounts,
        string calldata referenceId
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                employer,
                tokenIn,
                tokenOut,
                recipients,
                amounts,
                feeBps,
                feeRecipient,
                referenceId
            )
        );
    }

    /**
     * @notice Full cross-token digest. Additionally binds aggregate swap
     * parameters so the quoted swap intent is auditable offchain.
     */
    function canonicalCrossTokenDigest(
        address employer,
        address tokenIn,
        address tokenOut,
        address[] calldata recipients,
        uint256[] calldata outputAmounts,
        uint256 grossInput,
        uint256 minTotalOut,
        uint256 minHopPriceX36,
        uint256 deadline,
        string calldata referenceId
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                employer,
                tokenIn,
                tokenOut,
                recipients,
                outputAmounts,
                grossInput,
                minTotalOut,
                minHopPriceX36,
                deadline,
                feeBps,
                feeRecipient,
                referenceId
            )
        );
    }

    // -----------------------------------------------------------------------
    // Same-token payroll: USDC->USDC, EURC->EURC (ERC-20 only, no swap)
    // -----------------------------------------------------------------------

    /**
     * @notice Execute an atomic same-token payroll batch.
     * @param token Canonical USDC or EURC (input == output).
     * @param recipients Bounded recipient list.
     * @param amounts Exact per-recipient payroll obligations. Each recipient
     *        receives exactly amounts[i]; the platform fee is paid by the
     *        employer ON TOP of these obligations.
     * @param referenceId Caller-supplied unique reference id (global per
     *        employer replay domain: unusable again for any route once
     *        consumed).
     * @return totalOut Sum of exact obligations delivered (== sum(amounts)).
     *
     * Funding is ERC-20 only; msg.value must be 0 even for USDC. No Uniswap
     * call is made. totalFunding = sum(amounts) + sum(fee(amounts[i])) is
     * pulled from the employer; recipients receive exactly amounts[i] and
     * totalFees goes to the fee recipient.
     */
    function executeSameTokenPayroll(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        string calldata referenceId
    ) external payable nonReentrant whenNotPaused returns (uint256 totalOut) {
        if (token != USDC && token != EURC) {
            revert UnsupportedPayrollPair(token, token);
        }
        if (msg.value != 0) {
            revert NativeMsgValueMismatch(msg.value, 0);
        }
        _validateBatch(recipients, amounts, referenceId);

        bytes32 referenceHash = canonicalReferenceHash(msg.sender, referenceId);
        if (usedReferenceHashes[referenceHash]) revert ReferenceAlreadyUsed(referenceHash);
        usedReferenceHashes[referenceHash] = true;

        // amounts[] are exact recipient obligations. The employer funds the
        // obligations plus the platform fee on top.
        uint256 totalObligations;
        uint256 totalFees;
        for (uint256 i; i < recipients.length; ++i) {
            _validateRecipient(recipients[i]);
            if (amounts[i] == 0) revert AmountMustBeGreaterThanZero();
            totalObligations += amounts[i];
            totalFees += _fee(amounts[i]);
        }
        uint256 totalFunding = totalObligations + totalFees;
        totalOut = totalObligations;

        IERC20 payrollToken = IERC20(token);
        uint256 balanceBefore = payrollToken.balanceOf(address(this));
        payrollToken.safeTransferFrom(msg.sender, address(this), totalFunding);
        uint256 balanceAfterFunding = payrollToken.balanceOf(address(this));
        if (balanceAfterFunding != balanceBefore + totalFunding) {
            revert ResidualInputBalance(balanceBefore + totalFunding, balanceAfterFunding);
        }

        if (totalFees != 0) {
            payrollToken.safeTransfer(feeRecipient, totalFees);
        }
        for (uint256 i; i < recipients.length; ++i) {
            payrollToken.safeTransfer(recipients[i], amounts[i]);
            emit PayrollPayment(referenceHash, msg.sender, token, recipients[i], i, amounts[i]);
        }

        uint256 balanceAfter = payrollToken.balanceOf(address(this));
        if (balanceAfter != balanceBefore) {
            revert ResidualOutputBalance(balanceBefore, balanceAfter);
        }

        bytes32 batchDigest = this.canonicalBatchDigest(msg.sender, token, token, recipients, amounts, referenceId);
        emit PayrollReferenceConsumed(
            referenceHash,
            msg.sender,
            token,
            token,
            batchDigest,
            totalFunding,
            totalOut,
            totalFees,
            recipients.length,
            referenceId
        );
        emit PayrollBatchExecuted(
            msg.sender, token, token, totalFunding, totalOut, totalFees, recipients.length, referenceId
        );
    }

    // -----------------------------------------------------------------------
    // Cross-token payroll: USDC->EURC, EURC->USDC (one aggregate V4 swap)
    // -----------------------------------------------------------------------

    /**
     * @notice Execute an atomic cross-token payroll batch.
     * @param tokenIn Canonical input token (USDC or EURC).
     * @param tokenOut Canonical output token (the other of USDC/EURC).
     * @param recipients Bounded recipient list.
     * @param outputAmounts Exact per-recipient obligations in the output token.
     * @param grossInput Aggregate input in the input token (6-decimal units).
     * @param minTotalOut Slippage-protected minimum aggregate swap output.
     *        Must be >= sum(outputAmounts).
     * @param minHopPriceX36 Per-hop price floor for the V4 swap.
     * @param deadline Swap deadline, bounded to [now, now + 20 minutes].
     * @param referenceId Caller-supplied unique reference id.
     * @return amountOut Actual aggregate swap output.
     *
     * USDC input is native-only: msg.value must equal grossInput * 1e12.
     * EURC input is ERC-20 via Permit2: msg.value must be 0, caller must have
     * approved this contract for grossInput EURC. Swap output is taken to
     * this contract, obligations are paid only after sufficient output is
     * proven, surplus is refunded to the employer. Everything reverts if
     * obligations cannot all be paid.
     */
    function executeCrossTokenPayroll(
        address tokenIn,
        address tokenOut,
        address[] calldata recipients,
        uint256[] calldata outputAmounts,
        uint256 grossInput,
        uint256 minTotalOut,
        uint256 minHopPriceX36,
        uint256 deadline,
        string calldata referenceId
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        bool usdcIn = tokenIn == USDC && tokenOut == EURC;
        bool eurcIn = tokenIn == EURC && tokenOut == USDC;
        if (!usdcIn && !eurcIn) {
            revert UnsupportedPayrollPair(tokenIn, tokenOut);
        }
        uint256 totalObligations = _validateCrossTokenDetails(
            recipients, outputAmounts, grossInput, minTotalOut, minHopPriceX36, deadline, referenceId
        );

        bytes32 referenceHash = canonicalReferenceHash(msg.sender, referenceId);
        if (usedReferenceHashes[referenceHash]) revert ReferenceAlreadyUsed(referenceHash);
        usedReferenceHashes[referenceHash] = true;

        uint256 feeAmount = _fee(grossInput);
        uint256 netAmountIn = grossInput - feeAmount;

        uint256 startOutputBal = IERC20(tokenOut).balanceOf(address(this));
        // EURC input only. Arc native USDC is coupled with IERC20(USDC).balanceOf,
        // so msg.value is already included in that reading. USDC input residual
        // accounting is ResidualNativeBalance inside _executeCrossUsdcInput.
        uint256 startInputBal;
        if (eurcIn) {
            startInputBal = IERC20(tokenIn).balanceOf(address(this));
        }

        if (usdcIn) {
            _executeCrossUsdcInput(grossInput, netAmountIn, feeAmount, minTotalOut, minHopPriceX36, deadline, msg.value);
        } else {
            _executeCrossEurcInput(
                tokenIn, grossInput, netAmountIn, feeAmount, minTotalOut, minHopPriceX36, deadline, msg.value
            );
        }

        amountOut = _settleCrossTokenOutputs(
            tokenOut, recipients, outputAmounts, totalObligations, startOutputBal, minTotalOut, referenceHash
        );

        if (eurcIn) {
            uint256 finalInputBal = IERC20(tokenIn).balanceOf(address(this));
            if (finalInputBal != startInputBal) {
                revert ResidualInputBalance(startInputBal, finalInputBal);
            }
        }

        emit PayrollSwapExecuted(
            referenceHash, msg.sender, tokenIn, tokenOut, grossInput, feeAmount, netAmountIn, amountOut, minTotalOut
        );

        bytes32 batchDigest = this.canonicalCrossTokenDigest(
            msg.sender,
            tokenIn,
            tokenOut,
            recipients,
            outputAmounts,
            grossInput,
            minTotalOut,
            minHopPriceX36,
            deadline,
            referenceId
        );
        emit PayrollReferenceConsumed(
            referenceHash,
            msg.sender,
            tokenIn,
            tokenOut,
            batchDigest,
            grossInput,
            totalObligations,
            feeAmount,
            recipients.length,
            referenceId
        );
        emit PayrollBatchExecuted(
            msg.sender, tokenIn, tokenOut, grossInput, totalObligations, feeAmount, recipients.length, referenceId
        );
    }

    function _validateCrossTokenDetails(
        address[] calldata recipients,
        uint256[] calldata outputAmounts,
        uint256 grossInput,
        uint256 minTotalOut,
        uint256 minHopPriceX36,
        uint256 deadline,
        string calldata referenceId
    ) internal view returns (uint256 totalObligations) {
        _validateBatch(recipients, outputAmounts, referenceId);
        if (grossInput == 0) revert AmountMustBeGreaterThanZero();
        if (grossInput > type(uint128).max) revert AmountInExceedsUint128(grossInput);
        if (minTotalOut == 0) revert MinTotalOutZero();
        if (minTotalOut > type(uint128).max) revert MinAmountOutExceedsUint128(minTotalOut);
        if (minHopPriceX36 == 0) revert MinHopPriceX36Zero();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline, block.timestamp);
        if (deadline > block.timestamp + MAX_DEADLINE_WINDOW) {
            revert DeadlineTooFar(deadline, block.timestamp + MAX_DEADLINE_WINDOW);
        }
        for (uint256 i; i < recipients.length; ++i) {
            _validateRecipient(recipients[i]);
            if (outputAmounts[i] == 0) revert AmountMustBeGreaterThanZero();
            totalObligations += outputAmounts[i];
        }
        if (minTotalOut < totalObligations) {
            revert MinTotalOutBelowObligations(minTotalOut, totalObligations);
        }
    }

    function _settleCrossTokenOutputs(
        address tokenOut,
        address[] calldata recipients,
        uint256[] calldata outputAmounts,
        uint256 totalObligations,
        uint256 startOutputBal,
        uint256 minTotalOut,
        bytes32 referenceHash
    ) internal returns (uint256 amountOut) {
        IERC20 outputToken = IERC20(tokenOut);
        amountOut = outputToken.balanceOf(address(this)) - startOutputBal;
        if (amountOut < totalObligations) revert InsufficientSwapOutput(amountOut, totalObligations);
        if (amountOut < minTotalOut) revert SlippageExceeded(amountOut, minTotalOut);
        for (uint256 i; i < recipients.length; ++i) {
            outputToken.safeTransfer(recipients[i], outputAmounts[i]);
            emit PayrollPayment(referenceHash, msg.sender, tokenOut, recipients[i], i, outputAmounts[i]);
        }
        uint256 surplus = amountOut - totalObligations;
        if (surplus != 0) {
            outputToken.safeTransfer(msg.sender, surplus);
            emit PayrollSurplusRefunded(referenceHash, msg.sender, tokenOut, surplus);
        }
        if (outputToken.balanceOf(address(this)) != startOutputBal) {
            revert ResidualOutputBalance(startOutputBal, outputToken.balanceOf(address(this)));
        }
    }

    // -----------------------------------------------------------------------
    // Internal: cross-token input legs
    // -----------------------------------------------------------------------

    function _executeCrossUsdcInput(
        uint256 grossInput,
        uint256 netAmountIn,
        uint256 feeAmount,
        uint256 minTotalOut,
        uint256 minHopPriceX36,
        uint256 deadline,
        uint256 msgValue
    ) internal {
        uint256 expectedNative = grossInput * ARC_NATIVE_USDC_SCALE;
        if (msgValue != expectedNative) {
            revert NativeMsgValueMismatch(msgValue, expectedNative);
        }
        uint256 priorNativeBal = address(this).balance - msgValue;

        if (feeAmount != 0) {
            // slither-disable-next-line low-level-calls
            (bool ok,) = payable(feeRecipient).call{value: feeAmount * ARC_NATIVE_USDC_SCALE}("");
            if (!ok) revert NativeTransferFailed();
        }

        uint256 netNative = netAmountIn * ARC_NATIVE_USDC_SCALE;
        {
            bytes memory commands = abi.encodePacked(_CMD_V4_SWAP);
            bytes[] memory inputs = new bytes[](1);
            // TAKE to this payroll contract; fan-out happens after output proof.
            inputs[0] = _buildV4SwapInput(USDC, EURC, netAmountIn, minTotalOut, minHopPriceX36, address(this), false);
            // slither-disable-next-line arbitrary-send-eth
            universalRouter.execute{value: netNative}(commands, inputs, deadline);
        }

        uint256 endNativeBal = address(this).balance;
        if (endNativeBal != priorNativeBal) {
            revert ResidualNativeBalance(priorNativeBal, endNativeBal);
        }
    }

    function _executeCrossEurcInput(
        address tokenIn,
        uint256 grossInput,
        uint256 netAmountIn,
        uint256 feeAmount,
        uint256 minTotalOut,
        uint256 minHopPriceX36,
        uint256 deadline,
        uint256 msgValue
    ) internal {
        if (msgValue != 0) revert NativeMsgValueMismatch(msgValue, 0);

        IERC20 inputToken = IERC20(tokenIn);
        uint256 startInputBal = inputToken.balanceOf(address(this));

        inputToken.safeTransferFrom(msg.sender, address(this), grossInput);
        uint256 afterFunding = inputToken.balanceOf(address(this));
        if (afterFunding != startInputBal + grossInput) {
            revert ResidualInputBalance(startInputBal + grossInput, afterFunding);
        }

        if (feeAmount != 0) {
            inputToken.safeTransfer(feeRecipient, feeAmount);
        }

        inputToken.forceApprove(address(permit2), netAmountIn);
        uint48 expiry = (deadline + 1).toUint48();
        permit2.approve(tokenIn, address(universalRouter), netAmountIn.toUint160(), expiry);

        {
            bytes memory commands = abi.encodePacked(_CMD_V4_SWAP);
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = _buildV4SwapInput(EURC, USDC, netAmountIn, minTotalOut, minHopPriceX36, address(this), true);
            // slither-disable-next-line arbitrary-send-eth
            universalRouter.execute{value: 0}(commands, inputs, deadline);
        }

        inputToken.forceApprove(address(permit2), 0);
        permit2.approve(tokenIn, address(universalRouter), 0, 0);
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

    function _validateBatch(address[] calldata recipients, uint256[] calldata amounts, string calldata referenceId)
        internal
        pure
    {
        if (recipients.length == 0) revert EmptyBatch();
        if (recipients.length != amounts.length) revert ArrayLengthMismatch();
        if (recipients.length > MAX_BATCH_SIZE) revert BatchTooLarge(recipients.length, MAX_BATCH_SIZE);
        uint256 length = bytes(referenceId).length;
        if (length == 0) revert ReferenceIdRequired();
        if (length > MAX_REFERENCE_ID_LENGTH) revert ReferenceIdTooLong(length, MAX_REFERENCE_ID_LENGTH);
    }

    function _validateRecipient(address recipient) internal view {
        if (recipient == address(0)) revert RecipientZeroAddress();
        if (recipient == msg.sender) revert SelfPaymentNotAllowed(msg.sender);
        if (recipient == address(this)) revert ContractRecipientNotAllowed(recipient);
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return feeBps == 0 ? 0 : (amount * feeBps) / 10_000;
    }

    // -----------------------------------------------------------------------
    // Payload construction (exact approved PoolKey only, no arbitrary calldata)
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

        params[1] = abi.encode(tokenIn, uint256(0), payerIsUser);
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
