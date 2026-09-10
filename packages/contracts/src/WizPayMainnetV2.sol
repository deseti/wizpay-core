// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Future Arc Mainnet direct-USDC payroll contract.
/// @dev It deliberately has no FX engine or cross-token execution entry point.
contract WizPayMainnetV2 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    error CanonicalUsdcZeroAddress();
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
    error AmountMustBeGreaterThanZero();
    error DirectTransferBelowMinimum(uint256 amountOut, uint256 minAmountOut);
    error InsufficientTokenBalance(uint256 balance, uint256 amount);

    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant MAX_REFERENCE_ID_LENGTH = 64;

    IERC20 public immutable canonicalUsdc;
    uint256 public feeBps;
    address public feeCollector;
    mapping(bytes32 => bool) public usedReferenceHashes;

    event PayrollReferenceConsumed(
        bytes32 indexed referenceHash,
        address indexed payer,
        address indexed token,
        bytes32 batchDigest,
        uint256 totalAmount,
        uint256 totalFees,
        uint256 recipientCount,
        string referenceId
    );
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event FeeCollected(address indexed token, uint256 amount);
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);

    constructor(address _canonicalUsdc, address _feeCollector, uint256 _feeBps) Ownable(msg.sender) {
        if (_canonicalUsdc == address(0)) revert CanonicalUsdcZeroAddress();
        if (_feeCollector == address(0)) revert FeeCollectorZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(_feeBps, MAX_FEE_BPS);
        canonicalUsdc = IERC20(_canonicalUsdc);
        feeCollector = _feeCollector;
        feeBps = _feeBps;
    }

    function canonicalReferenceHash(address payer, string calldata referenceId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), payer, address(canonicalUsdc), referenceId));
    }

    function canonicalBatchDigest(address[] calldata recipients, uint256[] calldata amounts)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(canonicalUsdc), recipients, amounts));
    }

    /// @notice Executes one atomic, same-token direct-USDC payroll batch.
    /// @dev The reference is marked before token calls. Any later revert rolls
    /// back the mapping write under EVM transaction atomicity.
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
            if (amountsIn[i] == 0) revert AmountMustBeGreaterThanZero();
            totalAmount += amountsIn[i];
        }

        canonicalUsdc.safeTransferFrom(msg.sender, address(this), totalAmount);
        uint256 totalFees;
        for (uint256 i; i < recipients.length; ++i) {
            address recipient = recipients[i];
            uint256 amount = amountsIn[i];
            uint256 fee = _fee(amount);
            uint256 net = amount - fee;
            if (net < minAmountsOut[i]) {
                revert DirectTransferBelowMinimum(net, minAmountsOut[i]);
            }
            if (fee != 0) {
                canonicalUsdc.safeTransfer(feeCollector, fee);
                emit FeeCollected(address(canonicalUsdc), fee);
            }
            canonicalUsdc.safeTransfer(recipient, net);
            totalFees += fee;
            totalOut += net;
        }

        emit PayrollReferenceConsumed(
            referenceHash,
            msg.sender,
            address(canonicalUsdc),
            canonicalBatchDigest(recipients, amountsIn),
            totalAmount,
            totalFees,
            recipients.length,
            referenceId
        );
    }

    function updateFee(uint256 nextFeeBps) external onlyOwner {
        if (nextFeeBps > MAX_FEE_BPS) revert FeeExceedsMaximum(nextFeeBps, MAX_FEE_BPS);
        uint256 old = feeBps;
        feeBps = nextFeeBps;
        emit FeeUpdated(old, nextFeeBps);
    }

    function updateFeeCollector(address nextCollector) external onlyOwner {
        if (nextCollector == address(0)) revert FeeCollectorZeroAddress();
        address old = feeCollector;
        feeCollector = nextCollector;
        emit FeeCollectorUpdated(old, nextCollector);
    }

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token != address(canonicalUsdc)) revert TokenMustBeCanonicalUsdc(token);
        if (amount == 0) revert AmountMustBeGreaterThanZero();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) revert InsufficientTokenBalance(balance, amount);
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdraw(token, amount, owner());
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
        ) {
            revert ArrayLengthMismatch();
        }
        if (recipients.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge(recipients.length, MAX_BATCH_SIZE);
        }
        uint256 length = bytes(referenceId).length;
        if (length == 0) revert ReferenceIdRequired();
        if (length > MAX_REFERENCE_ID_LENGTH) {
            revert ReferenceIdTooLong(length, MAX_REFERENCE_ID_LENGTH);
        }
    }

    function _fee(uint256 amount) private view returns (uint256) {
        return feeBps == 0 || feeCollector == address(0) ? 0 : amount * feeBps / 10_000;
    }
}
