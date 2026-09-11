// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {WizPayMainnetV2} from "src/WizPayMainnetV2.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external virtual returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external virtual returns (bool) {
        return false;
    }
}

contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount);
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract FeeOnTransferToken is FalseReturnToken {
    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount);
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - 1;
        return true;
    }
}

contract ReentrantToken is FalseReturnToken {
    WizPayMainnetV2 public target;
    bool public reentryBlocked;
    bool private attacking;

    function setTarget(WizPayMainnetV2 next) external {
        target = next;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount);
        if (!attacking) {
            attacking = true;
            address[] memory tokens = new address[](1);
            tokens[0] = address(this);
            address[] memory recipients = new address[](1);
            recipients[0] = address(0xBEEF);
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = 1;
            try target.batchRouteAndPay(address(this), tokens, recipients, amounts, amounts, "REENTER") {
                reentryBlocked = false;
            } catch {
                reentryBlocked = true;
            }
            attacking = false;
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract WizPayMainnetV2Test is Test {
    MockERC20 internal usdc;
    MockERC20 internal other;
    WizPayMainnetV2 internal payroll;
    address internal payer = makeAddr("payer");
    address internal recipientA = makeAddr("recipient-a");
    address internal recipientB = makeAddr("recipient-b");
    address internal safe = makeAddr("mainnet-safe");
    address internal feeCollector = makeAddr("authorized-fee-recipient");

    function setUp() public {
        vm.etch(safe, hex"00");
        usdc = new MockERC20("USD Coin", "USDC", 6, 1_000_000e6);
        other = new MockERC20("Other", "OTHER", 6, 1_000_000e6);
        payroll = new WizPayMainnetV2(address(usdc), safe, feeCollector, 10);
        usdc.transfer(payer, 10_000e6);
        vm.prank(payer);
        usdc.approve(address(payroll), type(uint256).max);
    }

    function testConstructorRejectsInvalidInputsAndAssignsSafeDirectly() public {
        vm.expectRevert(WizPayMainnetV2.CanonicalUsdcZeroAddress.selector);
        new WizPayMainnetV2(address(0), safe, feeCollector, 0);
        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.CanonicalUsdcHasNoCode.selector, payer));
        new WizPayMainnetV2(payer, safe, feeCollector, 0);
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new WizPayMainnetV2(address(usdc), address(0), feeCollector, 0);
        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.InitialOwnerHasNoCode.selector, payer));
        new WizPayMainnetV2(address(usdc), payer, feeCollector, 0);
        vm.expectRevert(WizPayMainnetV2.FeeCollectorZeroAddress.selector);
        new WizPayMainnetV2(address(usdc), safe, address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.FeeExceedsMaximum.selector, 101, 100));
        new WizPayMainnetV2(address(usdc), safe, feeCollector, 101);
        assertEq(payroll.owner(), safe);
        assertNotEq(payroll.owner(), address(this));
    }

    function testOnlySafeControlsPauseFeesCollectorAndWithdrawal() public {
        vm.expectRevert();
        payroll.pause();
        vm.prank(safe);
        payroll.pause();
        vm.expectRevert();
        payroll.unpause();
        vm.expectRevert();
        payroll.updateFee(20);
        vm.expectRevert();
        payroll.updateFeeCollector(recipientA);
        vm.expectRevert();
        payroll.emergencyWithdraw(1);
        vm.prank(safe);
        payroll.updateFee(20);
        vm.prank(safe);
        payroll.updateFeeCollector(recipientA);
        assertEq(payroll.feeBps(), 20);
        assertEq(payroll.feeCollector(), recipientA);
        vm.prank(safe);
        payroll.unpause();
    }

    function testFeeChangesRequirePauseAndStayBounded() public {
        vm.expectRevert();
        vm.prank(safe);
        payroll.updateFee(0);
        vm.prank(safe);
        payroll.pause();
        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.FeeExceedsMaximum.selector, 101, 100));
        vm.prank(safe);
        payroll.updateFee(101);
        vm.expectRevert(WizPayMainnetV2.FeeCollectorZeroAddress.selector);
        vm.prank(safe);
        payroll.updateFeeCollector(address(0));
    }

    function testPausedExecutionRevertsAndAuthorizedUnpauseRestoresIt() public {
        vm.prank(safe);
        payroll.pause();
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(1e6, 2e6);
        vm.expectRevert();
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "PAUSED");
        vm.prank(safe);
        payroll.unpause();
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "UNPAUSED");
    }

    function testCanonicalPayrollConsumesPayerBoundReferenceAndRejectsReplay() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(100e6, 200e6);
        bytes32 hash = payroll.canonicalReferenceHash(payer, "PAYROLL-2026-09");
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "PAYROLL-2026-09"
        );
        assertTrue(payroll.usedReferenceHashes(hash));
        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.ReferenceAlreadyUsed.selector, hash));
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "PAYROLL-2026-09"
        );

        address otherPayer = makeAddr("other-payer");
        usdc.transfer(otherPayer, 300e6);
        vm.prank(otherPayer);
        usdc.approve(address(payroll), 300e6);
        assertNotEq(hash, payroll.canonicalReferenceHash(otherPayer, "PAYROLL-2026-09"));
        vm.prank(otherPayer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "PAYROLL-2026-09"
        );
    }

    function testRevertedExecutionDoesNotConsumeReference() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(100e6, 200e6);
        minimums[1] = 201e6;
        bytes32 hash = payroll.canonicalReferenceHash(payer, "RETRYABLE");
        vm.expectRevert();
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "RETRYABLE");
        assertFalse(payroll.usedReferenceHashes(hash));
        minimums[1] = 199_800_000;
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "RETRYABLE");
        assertTrue(payroll.usedReferenceHashes(hash));
    }

    function testRejectsNonCanonicalTokensBeforeSideEffects() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(10e6, 20e6);
        uint256 balanceBefore = usdc.balanceOf(payer);
        vm.expectRevert();
        vm.prank(payer);
        payroll.batchRouteAndPay(address(other), outputs(address(other), 2), recipients, amounts, minimums, "BAD-IN");
        vm.expectRevert();
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(other), 2), recipients, amounts, minimums, "BAD-OUT");
        assertEq(usdc.balanceOf(payer), balanceBefore);
        assertFalse(payroll.usedReferenceHashes(payroll.canonicalReferenceHash(payer, "BAD-OUT")));
    }

    function testInputValidationRejectsEmptyMismatchOversizeZeroAndSelf() public {
        address[] memory emptyAddress = new address[](0);
        uint256[] memory emptyUint = new uint256[](0);
        vm.expectRevert(WizPayMainnetV2.EmptyBatch.selector);
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), emptyAddress, emptyAddress, emptyUint, emptyUint, "EMPTY");
        address[] memory oneAddress = new address[](1);
        oneAddress[0] = recipientA;
        uint256[] memory oneAmount = new uint256[](1);
        oneAmount[0] = 1;
        vm.expectRevert(WizPayMainnetV2.ArrayLengthMismatch.selector);
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), emptyAddress, oneAddress, oneAmount, oneAmount, "MISMATCH");

        address[] memory manyAddresses = new address[](51);
        uint256[] memory manyAmounts = new uint256[](51);
        for (uint256 i; i < 51; ++i) {
            manyAddresses[i] = recipientA;
            manyAmounts[i] = 1;
        }
        vm.expectRevert();
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), 51), manyAddresses, manyAmounts, manyAmounts, "LARGE"
        );

        oneAddress[0] = address(0);
        vm.expectRevert(WizPayMainnetV2.RecipientZeroAddress.selector);
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 1), oneAddress, oneAmount, oneAmount, "ZERO-TO");
        oneAddress[0] = recipientA;
        oneAmount[0] = 0;
        vm.expectRevert(WizPayMainnetV2.AmountMustBeGreaterThanZero.selector);
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), 1), oneAddress, oneAmount, oneAmount, "ZERO-AMOUNT"
        );
        oneAddress[0] = payer;
        oneAmount[0] = 1;
        vm.expectRevert(WizPayMainnetV2.SelfPaymentNotAllowed.selector);
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 1), oneAddress, oneAmount, oneAmount, "SELF");
    }

    function testReferenceAndEstimateValidation() public {
        address[] memory recipients = singleton(recipientA);
        uint256[] memory amounts = singletonUint(1);
        address[] memory tokens = outputs(address(usdc), 1);
        vm.expectRevert(WizPayMainnetV2.ReferenceIdRequired.selector);
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), tokens, recipients, amounts, amounts, "");
        vm.expectRevert();
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc),
            tokens,
            recipients,
            amounts,
            amounts,
            "12345678901234567890123456789012345678901234567890123456789012345"
        );
        vm.expectRevert(WizPayMainnetV2.ArrayLengthMismatch.selector);
        payroll.getBatchEstimatedOutputs(address(usdc), new address[](0), amounts);
        vm.expectRevert();
        payroll.getBatchEstimatedOutputs(address(other), tokens, amounts);
    }

    function testFeeConservationRoundingDisabledFeeAndNoResidue() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(999, 10_001);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        uint256 out = payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "ROUNDING"
        );
        uint256 fees = amounts[0] * payroll.feeBps() / 10_000 + amounts[1] * payroll.feeBps() / 10_000;
        assertEq(payerBefore - usdc.balanceOf(payer), 11_000);
        assertEq(out + fees, 11_000);
        assertLe(fees, 11_000 * payroll.MAX_FEE_BPS() / 10_000);
        assertEq(usdc.balanceOf(address(payroll)), 0);

        vm.prank(safe);
        payroll.pause();
        vm.prank(safe);
        payroll.updateFee(0);
        vm.prank(safe);
        payroll.unpause();
        (recipients, amounts, minimums) = batch(7, 11);
        vm.prank(payer);
        assertEq(
            payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 2), recipients, amounts, amounts, "NO-FEE"),
            18
        );
        assertEq(usdc.balanceOf(address(payroll)), 0);
    }

    function testExistingResidualBalanceIsNeitherSpentNorIncreased() public {
        usdc.transfer(address(payroll), 123);
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(1e6, 2e6);
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 2), recipients, amounts, minimums, "RESIDUAL");
        assertEq(usdc.balanceOf(address(payroll)), 123);
    }

    function testBatchDigestBindsChainContractPayerTokenRecipientsAmountsAndOrder() public {
        (address[] memory recipients, uint256[] memory amounts,) = batch(10e6, 20e6);
        bytes32 original = payroll.canonicalBatchDigest(payer, recipients, amounts);
        assertNotEq(original, payroll.canonicalBatchDigest(recipientA, recipients, amounts));
        (recipients[0], recipients[1]) = (recipients[1], recipients[0]);
        assertNotEq(original, payroll.canonicalBatchDigest(payer, recipients, amounts));
        (recipients[0], recipients[1]) = (recipients[1], recipients[0]);
        amounts[0] += 1;
        assertNotEq(original, payroll.canonicalBatchDigest(payer, recipients, amounts));
        amounts[0] -= 1;
        WizPayMainnetV2 otherContract = new WizPayMainnetV2(address(usdc), safe, feeCollector, 10);
        assertNotEq(original, otherContract.canonicalBatchDigest(payer, recipients, amounts));
        WizPayMainnetV2 otherToken = new WizPayMainnetV2(address(other), safe, feeCollector, 10);
        assertNotEq(original, otherToken.canonicalBatchDigest(payer, recipients, amounts));
        vm.chainId(block.chainid + 1);
        assertNotEq(original, payroll.canonicalBatchDigest(payer, recipients, amounts));
    }

    function testEventsContainExactPaymentReferenceFeeAndDigest() public {
        address[] memory recipients = new address[](1);
        recipients[0] = recipientA;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1_000_001;
        uint256[] memory minimums = new uint256[](1);
        minimums[0] = 999_001;
        bytes32 referenceHash = payroll.canonicalReferenceHash(payer, "EVENTS");
        bytes32 digest = payroll.canonicalBatchDigest(payer, recipients, amounts);
        vm.expectEmit(true, true, true, true, address(payroll));
        emit WizPayMainnetV2.DirectUsdcPayment(referenceHash, payer, recipientA, 0, 1_000_001, 999_001, 1_000);
        vm.expectEmit(true, true, true, true, address(payroll));
        emit WizPayMainnetV2.PayrollReferenceConsumed(
            referenceHash, payer, address(usdc), digest, 1_000_001, 999_001, 1_000, 1, "EVENTS"
        );
        vm.prank(payer);
        payroll.batchRouteAndPay(address(usdc), outputs(address(usdc), 1), recipients, amounts, minimums, "EVENTS");
    }

    function testSafeERC20RejectsFalseReturnAndAcceptsNoReturn() public {
        FalseReturnToken bad = new FalseReturnToken();
        bad.mint(payer, 100);
        WizPayMainnetV2 badPayroll = new WizPayMainnetV2(address(bad), safe, feeCollector, 0);
        vm.prank(payer);
        bad.approve(address(badPayroll), 100);
        vm.expectRevert();
        vm.prank(payer);
        badPayroll.batchRouteAndPay(
            address(bad),
            outputs(address(bad), 1),
            singleton(recipientA),
            singletonUint(100),
            singletonUint(100),
            "FALSE"
        );
        assertFalse(badPayroll.usedReferenceHashes(badPayroll.canonicalReferenceHash(payer, "FALSE")));

        NoReturnToken compatible = new NoReturnToken();
        compatible.mint(payer, 100);
        WizPayMainnetV2 compatiblePayroll = new WizPayMainnetV2(address(compatible), safe, feeCollector, 0);
        vm.prank(payer);
        compatible.approve(address(compatiblePayroll), 100);
        vm.prank(payer);
        compatiblePayroll.batchRouteAndPay(
            address(compatible),
            outputs(address(compatible), 1),
            singleton(recipientA),
            singletonUint(100),
            singletonUint(100),
            "NO-RETURN"
        );
        assertEq(compatible.balanceOf(recipientA), 100);
    }

    function testRejectsFeeOnTransferFundingWithoutUsingResidualBalance() public {
        FeeOnTransferToken token = new FeeOnTransferToken();
        token.mint(payer, 100);
        token.mint(address(this), 10);
        WizPayMainnetV2 target = new WizPayMainnetV2(address(token), safe, feeCollector, 0);
        token.transfer(address(target), 10);
        vm.prank(payer);
        token.approve(address(target), 100);
        vm.expectRevert();
        vm.prank(payer);
        target.batchRouteAndPay(
            address(token),
            outputs(address(token), 1),
            singleton(recipientA),
            singletonUint(100),
            singletonUint(100),
            "TAXED"
        );
        assertEq(token.balanceOf(address(target)), 10);
    }

    function testReentrancyIsRejectedWithoutBreakingOuterPayment() public {
        ReentrantToken token = new ReentrantToken();
        token.mint(payer, 100);
        WizPayMainnetV2 target = new WizPayMainnetV2(address(token), safe, feeCollector, 0);
        token.setTarget(target);
        vm.prank(payer);
        token.approve(address(target), 100);
        vm.prank(payer);
        target.batchRouteAndPay(
            address(token),
            outputs(address(token), 1),
            singleton(recipientA),
            singletonUint(100),
            singletonUint(100),
            "OUTER"
        );
        assertTrue(token.reentryBlocked());
        assertEq(token.balanceOf(recipientA), 100);
    }

    function testEmergencyWithdrawalIsPauseGatedAuthorizedAndBalanceBounded() public {
        usdc.transfer(address(payroll), 50);
        vm.expectRevert();
        vm.prank(safe);
        payroll.emergencyWithdraw(1);
        vm.prank(safe);
        payroll.pause();
        vm.expectRevert();
        payroll.emergencyWithdraw(1);
        vm.expectRevert();
        vm.prank(safe);
        payroll.emergencyWithdraw(51);
        uint256 before = usdc.balanceOf(safe);
        vm.prank(safe);
        payroll.emergencyWithdraw(50);
        assertEq(usdc.balanceOf(safe) - before, 50);
        assertEq(usdc.balanceOf(address(payroll)), 0);
    }

    function testFuzzConservesExactDebitAndBoundsFee(uint96 rawA, uint96 rawB, uint8 rawFee) public {
        uint256 amountA = bound(uint256(rawA), 1, 400_000e6);
        uint256 amountB = bound(uint256(rawB), 1, 400_000e6);
        uint256 nextFee = bound(uint256(rawFee), 0, payroll.MAX_FEE_BPS());
        vm.prank(safe);
        payroll.pause();
        vm.prank(safe);
        payroll.updateFee(nextFee);
        vm.prank(safe);
        payroll.unpause();
        usdc.transfer(payer, amountA + amountB);
        (address[] memory recipients, uint256[] memory amounts,) = batch(amountA, amountB);
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 collectorBefore = usdc.balanceOf(feeCollector);
        vm.prank(payer);
        uint256 out = payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), 2), recipients, amounts, singletonPair(0, 0), "FUZZ-CONSERVATION"
        );
        uint256 fees = amountA * nextFee / 10_000 + amountB * nextFee / 10_000;
        assertEq(payerBefore - usdc.balanceOf(payer), amountA + amountB);
        assertEq(usdc.balanceOf(feeCollector) - collectorBefore, fees);
        assertEq(out + fees, amountA + amountB);
        assertEq(usdc.balanceOf(address(payroll)), 0);
    }

    function batch(uint256 amountA, uint256 amountB)
        private
        view
        returns (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums)
    {
        recipients = singletonPairAddress(recipientA, recipientB);
        amounts = singletonPair(amountA, amountB);
        minimums =
            singletonPair(amountA - amountA * payroll.feeBps() / 10_000, amountB - amountB * payroll.feeBps() / 10_000);
    }

    function outputs(address token, uint256 length) private pure returns (address[] memory tokens) {
        tokens = new address[](length);
        for (uint256 i; i < length; ++i) {
            tokens[i] = token;
        }
    }

    function singleton(address value) private pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = value;
    }

    function singletonUint(uint256 value) private pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = value;
    }

    function singletonPair(uint256 a, uint256 b) private pure returns (uint256[] memory values) {
        values = new uint256[](2);
        values[0] = a;
        values[1] = b;
    }

    function singletonPairAddress(address a, address b) private pure returns (address[] memory values) {
        values = new address[](2);
        values[0] = a;
        values[1] = b;
    }
}

contract MainnetPayrollInvariantHandler is Test {
    MockERC20 public immutable token;
    WizPayMainnetV2 public immutable payroll;
    address public immutable recipient;
    uint256 public totalDebited;
    uint256 public totalDelivered;
    uint256 public totalFees;
    bytes32[] public consumedHashes;

    constructor(MockERC20 token_, WizPayMainnetV2 payroll_, address recipient_) {
        token = token_;
        payroll = payroll_;
        recipient = recipient_;
        token.approve(address(payroll), type(uint256).max);
    }

    function pay(uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000e6);
        token.mint(address(this), amount);
        string memory referenceId = string.concat("INV-", vm.toString(consumedHashes.length));
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        uint256[] memory minimums = new uint256[](1);
        uint256 fee = amount * payroll.feeBps() / 10_000;
        minimums[0] = amount - fee;
        bytes32 hash = payroll.canonicalReferenceHash(address(this), referenceId);
        payroll.batchRouteAndPay(address(token), tokens, recipients, amounts, minimums, referenceId);
        consumedHashes.push(hash);
        totalDebited += amount;
        totalDelivered += amount - fee;
        totalFees += fee;
    }

    function tryUnauthorizedMutations(uint256 fee) external {
        try payroll.pause() {} catch {}
        try payroll.unpause() {} catch {}
        try payroll.updateFee(fee) {} catch {}
        try payroll.updateFeeCollector(address(this)) {} catch {}
        try payroll.emergencyWithdraw(1) {} catch {}
    }

    function consumedCount() external view returns (uint256) {
        return consumedHashes.length;
    }
}

contract WizPayMainnetV2InvariantTest is StdInvariant, Test {
    MockERC20 internal token;
    WizPayMainnetV2 internal payroll;
    MainnetPayrollInvariantHandler internal handler;
    address internal safe = makeAddr("invariant-safe");
    address internal collector = makeAddr("invariant-fee-recipient");
    address internal recipient = makeAddr("invariant-recipient");

    function setUp() public {
        vm.etch(safe, hex"00");
        token = new MockERC20("USD Coin", "USDC", 6, 0);
        payroll = new WizPayMainnetV2(address(token), safe, collector, 37);
        handler = new MainnetPayrollInvariantHandler(token, payroll, recipient);
        targetContract(address(handler));
    }

    function invariantConservationAndNoUnexpectedResidue() public view {
        assertEq(handler.totalDebited(), handler.totalDelivered() + handler.totalFees());
        assertEq(token.balanceOf(recipient), handler.totalDelivered());
        assertEq(token.balanceOf(collector), handler.totalFees());
        assertEq(token.balanceOf(address(payroll)), 0);
    }

    function invariantReferencesCannotBeReused() public view {
        uint256 count = handler.consumedCount();
        for (uint256 i; i < count; ++i) {
            assertTrue(payroll.usedReferenceHashes(handler.consumedHashes(i)));
        }
    }

    function invariantUnauthorizedStateCannotChange() public view {
        assertEq(payroll.owner(), safe);
        assertEq(payroll.feeCollector(), collector);
        assertEq(payroll.feeBps(), 37);
        assertFalse(payroll.paused());
        assertEq(address(payroll.canonicalUsdc()), address(token));
    }
}
