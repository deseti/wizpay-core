// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Arc Mainnet direct-USDC payroll contract.
/// @dev This contract is deliberately non-upgradeable and has no FX, router,
/// bridge, delegatecall, arbitrary-token, or arbitrary-call surface.
contract WizPayMainnetV2 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error CanonicalUsdcZeroAddress();
    error CanonicalUsdcHasNoCode(address canonicalUsdc);
    error InitialOwnerHasNoCode(address initialOwner);
    error FeeCollectorZeroAddress();
    error FeeExceedsMaximum(uint256 feeBps, uint256 maxFeeBps);
    error TokenMustBeCanonicalUsdc(address token);
    error EmptyBatch();
    error ArrayLengthMismatch();
    error BatchTooLarge(uint256 provided, uint256 maxAllowed);
    error ReferenceIdRequired();
    error ReferenceIdTooLong(uint256 provided, uint256 maxAllowed);
    error ReferenceAlreadyUsed(bytes32 referenceHash);
    error RecipientZeroAddress();
    error SelfPaymentNotAllowed();
    error AmountMustBeGreaterThanZero();
    error DirectTransferBelowMinimum(uint256 amountOut, uint256 minAmountOut);
    error InsufficientTokenBalance(uint256 balance, uint256 amount);
    error UnexpectedUsdcBalance(uint256 expected, uint256 actual);

    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant MAX_REFERENCE_ID_LENGTH = 64;

    IERC20 public immutable canonicalUsdc;
    uint256 public feeBps;
    address public feeCollector;
    mapping(bytes32 => bool) public usedReferenceHashes;

    event DirectUsdcPayment(
        bytes32 indexed referenceHash,
        address indexed payer,
        address indexed recipient,
        uint256 paymentIndex,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount
    );
    event PayrollReferenceConsumed(
        bytes32 indexed referenceHash,
        address indexed payer,
        address indexed token,
        bytes32 batchDigest,
        uint256 totalAmount,
        uint256 totalOut,
        uint256 totalFees,
        uint256 recipientCount,
        string referenceId
    );
    // Retained for existing payroll history consumers. Mainnet receipt
    // reconciliation additionally requires the two domain-bound events above.
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
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event FeeCollected(address indexed token, uint256 amount);
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);

    constructor(address _canonicalUsdc, address initialOwner, address _feeCollector, uint256 _feeBps)
        Ownable(initialOwner)
    {
        if (_canonicalUsdc == address(0)) revert CanonicalUsdcZeroAddress();
        if (_canonicalUsdc.code.length == 0) revert CanonicalUsdcHasNoCode(_canonicalUsdc);
        if (initialOwner.code.length == 0) revert InitialOwnerHasNoCode(initialOwner);
        if (_feeCollector == address(0)) revert FeeCollectorZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(_feeBps, MAX_FEE_BPS);
        canonicalUsdc = IERC20(_canonicalUsdc);
        feeCollector = _feeCollector;
        feeBps = _feeBps;
    }

    function canonicalReferenceHash(address payer, string calldata referenceId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), payer, address(canonicalUsdc), referenceId));
    }

    function canonicalBatchDigest(address payer, address[] calldata recipients, uint256[] calldata amounts)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), payer, address(canonicalUsdc), recipients, amounts));
    }

    /// @notice Returns the exact direct-USDC net amounts and fees.
    function getBatchEstimatedOutputs(address tokenIn, address[] calldata tokenOuts, uint256[] calldata amountsIn)
        external
        view
        returns (uint256[] memory estimatedAmountsOut, uint256 totalEstimatedOut, uint256 totalFees)
    {
        if (tokenIn != address(canonicalUsdc)) revert TokenMustBeCanonicalUsdc(tokenIn);
        if (amountsIn.length == 0) revert EmptyBatch();
        if (amountsIn.length != tokenOuts.length) revert ArrayLengthMismatch();
        if (amountsIn.length > MAX_BATCH_SIZE) revert BatchTooLarge(amountsIn.length, MAX_BATCH_SIZE);
        estimatedAmountsOut = new uint256[](amountsIn.length);
        for (uint256 i; i < amountsIn.length; ++i) {
            if (tokenOuts[i] != address(canonicalUsdc)) revert TokenMustBeCanonicalUsdc(tokenOuts[i]);
            if (amountsIn[i] == 0) revert AmountMustBeGreaterThanZero();
            uint256 fee = _fee(amountsIn[i]);
            uint256 net = amountsIn[i] - fee;
            estimatedAmountsOut[i] = net;
            totalEstimatedOut += net;
            totalFees += fee;
        }
    }

    /// @notice Executes one atomic, same-token direct-USDC payroll batch.
    /// @dev The reference is consumed before token calls. Any later revert
    /// rolls the mapping write back under EVM transaction atomicity.
    function batchRouteAndPay(
        address tokenIn,
        address[] calldata tokenOuts,
        address[] calldata recipients,
        uint256[] calldata amountsIn,
        uint256[] calldata minAmountsOut,
        string calldata referenceId
    ) external nonReentrant whenNotPaused returns (uint256 totalOut) {
        if (tokenIn != address(canonicalUsdc)) revert TokenMustBeCanonicalUsdc(tokenIn);
        _validate(tokenOuts, recipients, amountsIn, minAmountsOut, referenceId);

        bytes32 referenceHash = canonicalReferenceHash(msg.sender, referenceId);
        if (usedReferenceHashes[referenceHash]) revert ReferenceAlreadyUsed(referenceHash);
        usedReferenceHashes[referenceHash] = true;

        uint256 totalAmount;
        for (uint256 i; i < recipients.length; ++i) {
            if (tokenOuts[i] != address(canonicalUsdc)) revert TokenMustBeCanonicalUsdc(tokenOuts[i]);
            if (recipients[i] == address(0)) revert RecipientZeroAddress();
            if (recipients[i] == msg.sender) revert SelfPaymentNotAllowed();
            if (amountsIn[i] == 0) revert AmountMustBeGreaterThanZero();
            totalAmount += amountsIn[i];
        }

        uint256 balanceBefore = canonicalUsdc.balanceOf(address(this));
        canonicalUsdc.safeTransferFrom(msg.sender, address(this), totalAmount);
        uint256 balanceAfterFunding = canonicalUsdc.balanceOf(address(this));
        uint256 expectedAfterFunding = balanceBefore + totalAmount;
        if (balanceAfterFunding != expectedAfterFunding) {
            revert UnexpectedUsdcBalance(expectedAfterFunding, balanceAfterFunding);
        }

        uint256 totalFees;
        for (uint256 i; i < recipients.length; ++i) {
            uint256 amount = amountsIn[i];
            uint256 fee = _fee(amount);
            uint256 net = amount - fee;
            if (net < minAmountsOut[i]) revert DirectTransferBelowMinimum(net, minAmountsOut[i]);
            if (fee != 0) {
                canonicalUsdc.safeTransfer(feeCollector, fee);
                emit FeeCollected(address(canonicalUsdc), fee);
            }
            canonicalUsdc.safeTransfer(recipients[i], net);
            totalFees += fee;
            totalOut += net;
            emit DirectUsdcPayment(referenceHash, msg.sender, recipients[i], i, amount, net, fee);
        }

        uint256 balanceAfterPayment = canonicalUsdc.balanceOf(address(this));
        if (balanceAfterPayment != balanceBefore) {
            revert UnexpectedUsdcBalance(balanceBefore, balanceAfterPayment);
        }

        bytes32 batchDigest = canonicalBatchDigest(msg.sender, recipients, amountsIn);
        emit PayrollReferenceConsumed(
            referenceHash,
            msg.sender,
            address(canonicalUsdc),
            batchDigest,
            totalAmount,
            totalOut,
            totalFees,
            recipients.length,
            referenceId
        );
        emit BatchPaymentRouted(
            msg.sender,
            address(canonicalUsdc),
            address(canonicalUsdc),
            totalAmount,
            totalOut,
            totalFees,
            recipients.length,
            referenceId
        );
    }

    /// @dev Fee changes are pause-gated so a successful payment cannot execute
    /// concurrently with a governance fee change.
    function updateFee(uint256 nextFeeBps) external onlyOwner whenPaused {
        if (nextFeeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(nextFeeBps, MAX_FEE_BPS);
        uint256 old = feeBps;
        feeBps = nextFeeBps;
        emit FeeUpdated(old, nextFeeBps);
    }

    function updateFeeCollector(address nextCollector) external onlyOwner whenPaused {
        if (nextCollector == address(0)) revert FeeCollectorZeroAddress();
        address old = feeCollector;
        feeCollector = nextCollector;
        emit FeeCollectorUpdated(old, nextCollector);
    }

    /// @notice Recovers only canonical USDC actually held by the contract.
    /// @dev The owner is the authorized Safe and recovery is possible only while
    /// payment execution is paused. The Safe remains a residual trust boundary.
    function emergencyWithdraw(uint256 amount) external onlyOwner whenPaused nonReentrant {
        if (amount == 0) revert AmountMustBeGreaterThanZero();
        uint256 balance = canonicalUsdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientTokenBalance(balance, amount);
        canonicalUsdc.safeTransfer(owner(), amount);
        emit EmergencyWithdraw(address(canonicalUsdc), amount, owner());
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _validate(
        address[] calldata tokenOuts,
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint256[] calldata minimums,
        string calldata referenceId
    ) private pure {
        if (recipients.length == 0) revert EmptyBatch();
        if (
            recipients.length != tokenOuts.length || recipients.length != amounts.length
                || recipients.length != minimums.length
        ) revert ArrayLengthMismatch();
        if (recipients.length > MAX_BATCH_SIZE) revert BatchTooLarge(recipients.length, MAX_BATCH_SIZE);
        uint256 length = bytes(referenceId).length;
        if (length == 0) revert ReferenceIdRequired();
        if (length > MAX_REFERENCE_ID_LENGTH) revert ReferenceIdTooLong(length, MAX_REFERENCE_ID_LENGTH);
    }

    function _fee(uint256 amount) private view returns (uint256) {
        return feeBps == 0 ? 0 : amount * feeBps / 10_000;
    }
}
