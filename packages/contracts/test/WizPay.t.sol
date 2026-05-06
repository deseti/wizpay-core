// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {WizPay} from "src/WizPay.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";
import {MockFXEngine} from "src/mocks/MockFXEngine.sol";

contract WizPayTest is Test {
    event FXEngineUpdated(address indexed oldEngine, address indexed newEngine);

    event PaymentRouted(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );

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

    uint256 internal constant INITIAL_SUPPLY = 1_000_000e6;
    uint256 internal constant EURC_TO_USDC_RATE = 1_100_000_000_000_000_000;
    uint256 internal constant USDC_TO_EURC_RATE = 909_090_909_090_909_090;
    uint256 internal constant FEE_BPS = 10;

    WizPay internal wizPay;
    MockFXEngine internal fxEngine;
    MockERC20 internal mockEURC;
    MockERC20 internal mockUSDC;

    address internal sender = makeAddr("sender");
    address internal recipient = makeAddr("recipient");
    address internal recipientA = makeAddr("recipient-a");
    address internal recipientB = makeAddr("recipient-b");
    address internal feeCollector = makeAddr("fee-collector");

    function setUp() public {
        mockEURC = new MockERC20("Mock Euro Coin", "EURC", 6, INITIAL_SUPPLY);
        mockUSDC = new MockERC20("Mock USD Coin", "USDC", 6, INITIAL_SUPPLY);

        fxEngine = new MockFXEngine();
        fxEngine.setExchangeRate(address(mockEURC), address(mockUSDC), EURC_TO_USDC_RATE);
        fxEngine.setExchangeRate(address(mockUSDC), address(mockEURC), USDC_TO_EURC_RATE);

        mockUSDC.transfer(address(fxEngine), 500_000e6);
        mockEURC.transfer(address(fxEngine), 500_000e6);

        wizPay = new WizPay(address(fxEngine), feeCollector, FEE_BPS);

        mockEURC.transfer(sender, 10_000e6);
        mockUSDC.transfer(sender, 10_000e6);
    }

    function testDeploymentSetsInitialState() public view {
        assertEq(address(wizPay.fxEngine()), address(fxEngine));
        assertEq(wizPay.owner(), address(this));
        assertEq(wizPay.feeCollector(), feeCollector);
        assertEq(wizPay.feeBps(), FEE_BPS);
    }

    function testDeploymentRevertsWhenFxEngineIsZero() public {
        vm.expectRevert(WizPay.FxEngineZeroAddress.selector);
        new WizPay(address(0), feeCollector, FEE_BPS);
    }

    function testDeploymentRevertsWhenFeeExceedsMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(WizPay.FeeExceedsMaximum.selector, 150, 100));
        new WizPay(address(fxEngine), feeCollector, 150);
    }

    function testRouteAndPaySwapTransfersOutputAndFee() public {
        uint256 paymentAmount = 1_000e6;
        uint256 minAmountOut = 1_090e6;
        uint256 feeAmount = (paymentAmount * FEE_BPS) / 10_000;
        uint256 amountAfterFee = paymentAmount - feeAmount;
        uint256 expectedOutputAfterFee = (1_100e6 * amountAfterFee) / paymentAmount;

        vm.prank(sender);
        mockEURC.approve(address(wizPay), paymentAmount);

        vm.expectEmit(true, true, true, true, address(wizPay));
        emit PaymentRouted(
            sender,
            recipient,
            address(mockEURC),
            address(mockUSDC),
            paymentAmount,
            expectedOutputAfterFee,
            feeAmount
        );

        vm.prank(sender);
        uint256 amountOut = wizPay.routeAndPay(
            address(mockEURC),
            address(mockUSDC),
            paymentAmount,
            minAmountOut,
            recipient
        );

        assertEq(amountOut, expectedOutputAfterFee);
        assertEq(mockEURC.balanceOf(sender), 9_000e6);
        assertEq(mockUSDC.balanceOf(recipient), expectedOutputAfterFee);
        assertEq(mockEURC.balanceOf(feeCollector), feeAmount);
        assertEq(mockEURC.balanceOf(address(wizPay)), 0);
        assertEq(mockUSDC.balanceOf(address(wizPay)), 0);
    }

    function testRouteAndPaySupportsReverseSwap() public {
        uint256 paymentAmount = 1_000e6;
        uint256 minAmountOut = 900e6;

        vm.prank(sender);
        mockUSDC.approve(address(wizPay), paymentAmount);

        vm.prank(sender);
        wizPay.routeAndPay(
            address(mockUSDC),
            address(mockEURC),
            paymentAmount,
            minAmountOut,
            recipient
        );

        assertGe(mockEURC.balanceOf(recipient), minAmountOut);
    }

    function testGetEstimatedOutputReturnsFeeAdjustedSameTokenAmount() public view {
        uint256 amountIn = 100e6;
        uint256 expectedFee = (amountIn * FEE_BPS) / 10_000;
        uint256 expectedNet = amountIn - expectedFee;

        uint256 estimate = wizPay.getEstimatedOutput(address(mockUSDC), address(mockUSDC), amountIn);

        assertEq(estimate, expectedNet);
    }

    function testBatchRouteAndPaySupportsMixedOutputs() public {
        address[] memory outputTokens = new address[](2);
        address[] memory recipients = new address[](2);
        uint256[] memory amountsIn = new uint256[](2);

        outputTokens[0] = address(mockUSDC);
        outputTokens[1] = address(mockEURC);
        recipients[0] = recipientA;
        recipients[1] = recipientB;
        amountsIn[0] = 100e6;
        amountsIn[1] = 50e6;

        vm.prank(sender);
        mockUSDC.approve(address(wizPay), amountsIn[0] + amountsIn[1]);

        (uint256[] memory estimates, uint256 totalEstimatedOut, uint256 totalFees) =
            wizPay.getBatchEstimatedOutputs(address(mockUSDC), outputTokens, amountsIn);

        assertEq(estimates.length, 2);
        assertEq(totalEstimatedOut, estimates[0] + estimates[1]);
        assertEq(totalFees, ((amountsIn[0] + amountsIn[1]) * FEE_BPS) / 10_000);

        uint256[] memory minAmountsOut = new uint256[](2);
        minAmountsOut[0] = (estimates[0] * 98) / 100;
        minAmountsOut[1] = (estimates[1] * 98) / 100;

        vm.expectEmit(true, true, true, true, address(wizPay));
        emit BatchPaymentRouted(
            sender,
            address(mockUSDC),
            address(0),
            amountsIn[0] + amountsIn[1],
            totalEstimatedOut,
            totalFees,
            recipients.length,
            "APR-2026-MIXED"
        );

        vm.prank(sender);
        wizPay.batchRouteAndPay(
            address(mockUSDC), outputTokens, recipients, amountsIn, minAmountsOut, "APR-2026-MIXED"
        );

        assertEq(mockUSDC.balanceOf(recipientA), estimates[0]);
        assertEq(mockEURC.balanceOf(recipientB), estimates[1]);
    }

    function testLegacyBatchRouteAndPayRemainsCompatible() public {
        address[] memory recipients = new address[](2);
        uint256[] memory amountsIn = new uint256[](2);
        uint256[] memory minAmountsOut = new uint256[](2);

        recipients[0] = recipientA;
        recipients[1] = recipientB;
        amountsIn[0] = 10e6;
        amountsIn[1] = 15e6;
        minAmountsOut[0] = 10e6;
        minAmountsOut[1] = 15e6;

        vm.prank(sender);
        mockEURC.approve(address(wizPay), amountsIn[0] + amountsIn[1]);

        vm.prank(sender);
        uint256 totalOut = wizPay.batchRouteAndPay(
            address(mockEURC),
            address(mockUSDC),
            recipients,
            amountsIn,
            minAmountsOut,
            "APR-2026-LEGACY"
        );

        assertGt(totalOut, 0);
        assertGt(mockUSDC.balanceOf(recipientA), 0);
        assertGt(mockUSDC.balanceOf(recipientB), 0);
    }

    function testRouteAndPayRevertsWhenSlippageProtectionFails() public {
        uint256 paymentAmount = 1_000e6;

        vm.prank(sender);
        mockEURC.approve(address(wizPay), paymentAmount);

        vm.expectRevert(MockFXEngine.SlippageToleranceExceeded.selector);
        vm.prank(sender);
        wizPay.routeAndPay(
            address(mockEURC),
            address(mockUSDC),
            paymentAmount,
            2_000e6,
            recipient
        );
    }

    function testRouteAndPayRevertsWhenMockEngineForcesBadSlippage() public {
        uint256 paymentAmount = 1_000e6;
        fxEngine.setSlippageFailure(true);

        vm.prank(sender);
        mockEURC.approve(address(wizPay), paymentAmount);

        vm.expectRevert(MockFXEngine.SlippageToleranceExceeded.selector);
        vm.prank(sender);
        wizPay.routeAndPay(
            address(mockEURC),
            address(mockUSDC),
            paymentAmount,
            1_000e6,
            recipient
        );
    }

    function testInputValidationRevertsOnZeroAddresses() public {
        vm.expectRevert(WizPay.TokenInZeroAddress.selector);
        wizPay.routeAndPay(address(0), address(mockUSDC), 1_000e6, 1_000e6, recipient);

        vm.expectRevert(WizPay.TokenOutZeroAddress.selector);
        wizPay.routeAndPay(address(mockEURC), address(0), 1_000e6, 1_000e6, recipient);

        vm.expectRevert(WizPay.AmountMustBeGreaterThanZero.selector);
        wizPay.routeAndPay(address(mockEURC), address(mockUSDC), 0, 1_000e6, recipient);
    }

    function testRouteAndPayRevertsWhenRecipientIsZeroAddress() public {
        vm.prank(sender);
        mockEURC.approve(address(wizPay), 1_000e6);

        vm.expectRevert(WizPay.RecipientZeroAddress.selector);
        vm.prank(sender);
        wizPay.routeAndPay(address(mockEURC), address(mockUSDC), 1_000e6, 1_000e6, address(0));
    }

    function testUpdateFxEngineIsRestrictedToOwner() public {
        MockFXEngine newFXEngine = new MockFXEngine();

        vm.expectEmit(true, true, true, true, address(wizPay));
        emit FXEngineUpdated(address(fxEngine), address(newFXEngine));
        wizPay.updateFXEngine(address(newFXEngine));
        assertEq(address(wizPay.fxEngine()), address(newFXEngine));

        bytes memory unauthorized = abi.encodeWithSignature(
            "OwnableUnauthorizedAccount(address)", sender
        );
        vm.expectRevert(unauthorized);
        vm.prank(sender);
        wizPay.updateFXEngine(address(fxEngine));
    }

    function testGetEstimatedOutputReturnsZeroWhenRateIsUnset() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 6, INITIAL_SUPPLY);

        uint256 estimate = wizPay.getEstimatedOutput(
            address(randomToken),
            address(mockUSDC),
            1_000e6
        );

        assertEq(estimate, 0);
    }

    function testWizPayDoesNotAccumulateBalancesAcrossPayments() public {
        uint256 paymentAmount = 100e6;

        for (uint256 i = 0; i < 5; i++) {
            vm.prank(sender);
            mockEURC.approve(address(wizPay), paymentAmount);

            vm.prank(sender);
            wizPay.routeAndPay(
                address(mockEURC),
                address(mockUSDC),
                paymentAmount,
                paymentAmount,
                recipient
            );

            assertEq(mockEURC.balanceOf(address(wizPay)), 0);
            assertEq(mockUSDC.balanceOf(address(wizPay)), 0);
        }
    }

    function testGetEstimatedOutputMatchesCurrentExchangeRate() public view {
        uint256 amountIn = 1_000e6;
        uint256 expectedOut = 1_098_900_000;

        uint256 estimate = wizPay.getEstimatedOutput(address(mockEURC), address(mockUSDC), amountIn);

        assertEq(estimate, expectedOut);
    }
}