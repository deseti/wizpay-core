// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {WizPayMainnetV2} from "src/WizPayMainnetV2.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

contract WizPayMainnetV2Test is Test {
    MockERC20 internal usdc;
    MockERC20 internal other;
    WizPayMainnetV2 internal payroll;
    address internal payer = makeAddr("payer");
    address internal recipientA = makeAddr("recipient-a");
    address internal recipientB = makeAddr("recipient-b");
    address internal feeCollector = makeAddr("fee-collector");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6, 1_000_000e6);
        other = new MockERC20("Other", "OTHER", 6, 1_000_000e6);
        payroll = new WizPayMainnetV2(address(usdc), feeCollector, 10);
        usdc.transfer(payer, 10_000e6);
        vm.prank(payer);
        usdc.approve(address(payroll), type(uint256).max);
    }

    function testRejectsZeroCriticalAddresses() public {
        vm.expectRevert(WizPayMainnetV2.CanonicalUsdcZeroAddress.selector);
        new WizPayMainnetV2(address(0), feeCollector, 0);
        vm.expectRevert(WizPayMainnetV2.FeeCollectorZeroAddress.selector);
        new WizPayMainnetV2(address(usdc), address(0), 0);
        vm.expectRevert(WizPayMainnetV2.FeeCollectorZeroAddress.selector);
        payroll.updateFeeCollector(address(0));
    }

    function testDirectPayrollConsumesReferenceAndRejectsReplay() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(100e6, 200e6);
        bytes32 referenceHash = payroll.canonicalReferenceHash(payer, "PAYROLL-2026-09");

        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), recipients.length), recipients, amounts, minimums, "PAYROLL-2026-09"
        );

        assertTrue(payroll.usedReferenceHashes(referenceHash));
        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.ReferenceAlreadyUsed.selector, referenceHash));
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), recipients.length), recipients, amounts, minimums, "PAYROLL-2026-09"
        );
    }

    function testRevertedPayrollDoesNotConsumeReference() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(100e6, 200e6);
        minimums[1] = 201e6;
        bytes32 referenceHash = payroll.canonicalReferenceHash(payer, "RETRYABLE");

        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.DirectTransferBelowMinimum.selector, 199_800_000, 201e6));
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), recipients.length), recipients, amounts, minimums, "RETRYABLE"
        );
        assertFalse(payroll.usedReferenceHashes(referenceHash));

        minimums[1] = 199_800_000;
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), recipients.length), recipients, amounts, minimums, "RETRYABLE"
        );
        assertTrue(payroll.usedReferenceHashes(referenceHash));
    }

    function testSameTokenExecutionHasNoFxSurface() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(10e6, 20e6);
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), recipients.length), recipients, amounts, minimums, "DIRECT-ONLY"
        );
        assertEq(usdc.balanceOf(recipientA), 9_990_000);
        assertEq(usdc.balanceOf(recipientB), 19_980_000);
    }

    function testCrossTokenIsRejectedBeforeTokenCalls() public {
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(10e6, 20e6);
        uint256 balanceBefore = usdc.balanceOf(payer);
        vm.expectRevert(abi.encodeWithSelector(WizPayMainnetV2.TokenMustBeCanonicalUsdc.selector, address(other)));
        vm.prank(payer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(other), recipients.length), recipients, amounts, minimums, "NO-FX"
        );
        assertEq(usdc.balanceOf(payer), balanceBefore);
    }

    function testFuzzReferenceReplay(address fuzzPayer, bytes32 salt, uint96 rawAmount) public {
        vm.assume(fuzzPayer != address(0));
        uint256 amount = bound(uint256(rawAmount), 1, 500_000e6);
        usdc.transfer(fuzzPayer, amount);
        vm.prank(fuzzPayer);
        usdc.approve(address(payroll), amount);
        address[] memory recipients = new address[](1);
        recipients[0] = recipientA;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        uint256[] memory minimums = new uint256[](1);
        minimums[0] = amount - (amount * 10 / 10_000);
        string memory payrollReference = string.concat("F-", vm.toString(uint128(uint256(salt))));

        vm.prank(fuzzPayer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), recipients.length), recipients, amounts, minimums, payrollReference
        );
        vm.expectRevert();
        vm.prank(fuzzPayer);
        payroll.batchRouteAndPay(
            address(usdc), outputs(address(usdc), recipients.length), recipients, amounts, minimums, payrollReference
        );
    }

    function testFuzzTotalDistribution(uint96 rawAmountA, uint96 rawAmountB) public {
        uint256 amountA = bound(uint256(rawAmountA), 1, 400_000e6);
        uint256 amountB = bound(uint256(rawAmountB), 1, 400_000e6);
        usdc.transfer(payer, amountA + amountB);
        (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums) = batch(amountA, amountB);
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 collectorBefore = usdc.balanceOf(feeCollector);

        vm.prank(payer);
        uint256 totalOut = payroll.batchRouteAndPay(
            address(usdc),
            outputs(address(usdc), recipients.length),
            recipients,
            amounts,
            minimums,
            "TOTAL-DISTRIBUTION"
        );

        uint256 expectedFees = amountA * 10 / 10_000 + amountB * 10 / 10_000;
        assertEq(payerBefore - usdc.balanceOf(payer), amountA + amountB);
        assertEq(usdc.balanceOf(recipientA) + usdc.balanceOf(recipientB), totalOut);
        assertEq(usdc.balanceOf(feeCollector) - collectorBefore, expectedFees);
        assertEq(totalOut + expectedFees, amountA + amountB);
        assertEq(usdc.balanceOf(address(payroll)), 0);
    }

    function testBatchDigestChangesWithOrderTokenOrAmount() public {
        (address[] memory recipients, uint256[] memory amounts,) = batch(10e6, 20e6);
        bytes32 original = payroll.canonicalBatchDigest(recipients, amounts);
        (recipients[0], recipients[1]) = (recipients[1], recipients[0]);
        assertNotEq(original, payroll.canonicalBatchDigest(recipients, amounts));
        (recipients[0], recipients[1]) = (recipients[1], recipients[0]);
        amounts[0] += 1;
        assertNotEq(original, payroll.canonicalBatchDigest(recipients, amounts));

        WizPayMainnetV2 otherTokenPayroll = new WizPayMainnetV2(address(other), feeCollector, 10);
        amounts[0] -= 1;
        assertNotEq(original, otherTokenPayroll.canonicalBatchDigest(recipients, amounts));
    }

    function batch(uint256 amountA, uint256 amountB)
        private
        view
        returns (address[] memory recipients, uint256[] memory amounts, uint256[] memory minimums)
    {
        recipients = new address[](2);
        recipients[0] = recipientA;
        recipients[1] = recipientB;
        amounts = new uint256[](2);
        amounts[0] = amountA;
        amounts[1] = amountB;
        minimums = new uint256[](2);
        minimums[0] = amountA - (amountA * 10 / 10_000);
        minimums[1] = amountB - (amountB * 10 / 10_000);
    }

    function outputs(address token, uint256 length) private pure returns (address[] memory tokens) {
        tokens = new address[](length);
        for (uint256 i; i < length; ++i) {
            tokens[i] = token;
        }
    }
}
