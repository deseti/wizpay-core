// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StableFXBridge} from "src/StableFXBridge.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

contract StableFXBridgeTest is Test {
    uint256 internal constant INITIAL_SUPPLY = 10_000_000e6;

    StableFXBridge internal bridge;
    MockERC20 internal usdc;
    MockERC20 internal eurc;

    address internal owner = makeAddr("owner");
    address internal orchestrator = makeAddr("orchestrator");
    address internal recipient = makeAddr("recipient");
    address internal caller = makeAddr("caller");

    function setUp() public {
        usdc = new MockERC20("Mock USD Coin", "USDC", 6, INITIAL_SUPPLY);
        eurc = new MockERC20("Mock Euro Coin", "EURC", 6, INITIAL_SUPPLY);

        bridge = new StableFXBridge(owner, orchestrator, address(usdc), address(eurc));

        // Fund orchestrator with EURC for pre-funding
        eurc.transfer(orchestrator, 1_000_000e6);
        // Fund caller with USDC for swaps
        usdc.transfer(caller, 1_000_000e6);
    }

    // ─── Constructor Tests ───────────────────────────────────────────────────────

    function testConstructorSetsState() public view {
        assertEq(bridge.owner(), owner);
        assertEq(bridge.orchestrator(), orchestrator);
        assertTrue(bridge.supportedTokens(address(usdc)));
        assertTrue(bridge.supportedTokens(address(eurc)));
    }

    function testConstructorRevertsOnZeroOwner() public {
        vm.expectRevert(StableFXBridge.ZeroAddress.selector);
        new StableFXBridge(address(0), orchestrator, address(usdc), address(eurc));
    }

    function testConstructorRevertsOnZeroOrchestrator() public {
        vm.expectRevert(StableFXBridge.ZeroAddress.selector);
        new StableFXBridge(owner, address(0), address(usdc), address(eurc));
    }

    // ─── preFund Tests ───────────────────────────────────────────────────────────

    function testPreFundDepositsTokensAndRecordsBalance() public {
        uint256 amount = 1000e6;

        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), amount);
        bridge.preFund(recipient, address(eurc), amount);
        vm.stopPrank();

        assertEq(bridge.preFundedBalances(recipient, address(eurc)), amount);
        assertEq(eurc.balanceOf(address(bridge)), amount);
    }

    function testPreFundAccumulatesBalance() public {
        uint256 amount1 = 500e6;
        uint256 amount2 = 300e6;

        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), amount1 + amount2);
        bridge.preFund(recipient, address(eurc), amount1);
        bridge.preFund(recipient, address(eurc), amount2);
        vm.stopPrank();

        assertEq(bridge.preFundedBalances(recipient, address(eurc)), amount1 + amount2);
    }

    function testPreFundEmitsEvent() public {
        uint256 amount = 1000e6;

        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), amount);

        vm.expectEmit(true, true, false, true);
        emit StableFXBridge.PreFunded(recipient, address(eurc), amount);
        bridge.preFund(recipient, address(eurc), amount);
        vm.stopPrank();
    }

    function testPreFundRevertsForNonOrchestrator() public {
        vm.prank(caller);
        vm.expectRevert(StableFXBridge.NotOrchestrator.selector);
        bridge.preFund(recipient, address(eurc), 1000e6);
    }

    function testPreFundRevertsForZeroRecipient() public {
        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), 1000e6);
        vm.expectRevert(StableFXBridge.ZeroAddress.selector);
        bridge.preFund(address(0), address(eurc), 1000e6);
        vm.stopPrank();
    }

    function testPreFundRevertsForUnsupportedToken() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 6, 1000e6);
        vm.startPrank(orchestrator);
        vm.expectRevert(abi.encodeWithSelector(StableFXBridge.TokenNotSupported.selector, address(randomToken)));
        bridge.preFund(recipient, address(randomToken), 1000e6);
        vm.stopPrank();
    }

    function testPreFundRevertsForZeroAmount() public {
        vm.startPrank(orchestrator);
        vm.expectRevert(StableFXBridge.AmountMustBeGreaterThanZero.selector);
        bridge.preFund(recipient, address(eurc), 0);
        vm.stopPrank();
    }

    // ─── swap Tests ──────────────────────────────────────────────────────────────

    function testSwapTransfersPreFundedTokensToRecipient() public {
        uint256 preFundAmount = 950e6;
        uint256 swapAmountIn = 1000e6;
        uint256 minAmountOut = 900e6;

        // Orchestrator pre-funds
        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), preFundAmount);
        bridge.preFund(recipient, address(eurc), preFundAmount);
        vm.stopPrank();

        // Caller approves and swaps
        vm.startPrank(caller);
        usdc.approve(address(bridge), swapAmountIn);
        uint256 amountOut = bridge.swap(address(usdc), address(eurc), swapAmountIn, minAmountOut, recipient);
        vm.stopPrank();

        // Verify outputs
        assertEq(amountOut, preFundAmount);
        assertEq(eurc.balanceOf(recipient), preFundAmount);
        assertEq(usdc.balanceOf(address(bridge)), swapAmountIn);
        assertEq(bridge.preFundedBalances(recipient, address(eurc)), 0);
    }

    function testSwapEmitsSwapCompletedEvent() public {
        uint256 preFundAmount = 950e6;
        uint256 swapAmountIn = 1000e6;

        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), preFundAmount);
        bridge.preFund(recipient, address(eurc), preFundAmount);
        vm.stopPrank();

        vm.startPrank(caller);
        usdc.approve(address(bridge), swapAmountIn);

        // We can't predict the exact swapId, but we can check the event is emitted
        vm.expectEmit(false, true, false, true);
        emit StableFXBridge.SwapCompleted(bytes32(0), address(eurc), preFundAmount, recipient);
        bridge.swap(address(usdc), address(eurc), swapAmountIn, 900e6, recipient);
        vm.stopPrank();
    }

    function testSwapRevertsForUnsupportedTokenIn() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 6, 1000e6);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StableFXBridge.TokenNotSupported.selector, address(randomToken)));
        bridge.swap(address(randomToken), address(eurc), 1000e6, 900e6, recipient);
    }

    function testSwapRevertsForUnsupportedTokenOut() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 6, 1000e6);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StableFXBridge.TokenNotSupported.selector, address(randomToken)));
        bridge.swap(address(usdc), address(randomToken), 1000e6, 900e6, recipient);
    }

    function testSwapRevertsForZeroAmountIn() public {
        vm.prank(caller);
        vm.expectRevert(StableFXBridge.AmountMustBeGreaterThanZero.selector);
        bridge.swap(address(usdc), address(eurc), 0, 0, recipient);
    }

    function testSwapRevertsWhenInsufficientPreFundedBalance() public {
        uint256 preFundAmount = 500e6;
        uint256 minAmountOut = 900e6;

        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), preFundAmount);
        bridge.preFund(recipient, address(eurc), preFundAmount);
        vm.stopPrank();

        vm.startPrank(caller);
        usdc.approve(address(bridge), 1000e6);
        vm.expectRevert(
            abi.encodeWithSelector(StableFXBridge.InsufficientPreFundedBalance.selector, preFundAmount, minAmountOut)
        );
        bridge.swap(address(usdc), address(eurc), 1000e6, minAmountOut, recipient);
        vm.stopPrank();
    }

    function testSwapRevertsWhenNoPreFundedBalance() public {
        vm.startPrank(caller);
        usdc.approve(address(bridge), 1000e6);
        vm.expectRevert(
            abi.encodeWithSelector(StableFXBridge.InsufficientPreFundedBalance.selector, 0, 900e6)
        );
        bridge.swap(address(usdc), address(eurc), 1000e6, 900e6, recipient);
        vm.stopPrank();
    }

    // ─── getEstimatedAmount Tests ────────────────────────────────────────────────

    function testGetEstimatedAmountReturnsSameAmount() public view {
        uint256 amountIn = 1000e6;
        uint256 estimated = bridge.getEstimatedAmount(address(usdc), address(eurc), amountIn);
        assertEq(estimated, amountIn);
    }

    function testGetEstimatedAmountRevertsForUnsupportedTokenIn() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 6, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(StableFXBridge.TokenNotSupported.selector, address(randomToken)));
        bridge.getEstimatedAmount(address(randomToken), address(eurc), 1000e6);
    }

    function testGetEstimatedAmountRevertsForUnsupportedTokenOut() public {
        MockERC20 randomToken = new MockERC20("Random", "RND", 6, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(StableFXBridge.TokenNotSupported.selector, address(randomToken)));
        bridge.getEstimatedAmount(address(usdc), address(randomToken), 1000e6);
    }

    // ─── completeSwap Tests ──────────────────────────────────────────────────────

    function testCompleteSwapRevertsForNonPendingSwap() public {
        bytes32 fakeSwapId = keccak256("fake");
        vm.prank(orchestrator);
        vm.expectRevert(abi.encodeWithSelector(StableFXBridge.SwapNotPending.selector, fakeSwapId));
        bridge.completeSwap(fakeSwapId);
    }

    function testCompleteSwapRevertsForNonOrchestrator() public {
        bytes32 fakeSwapId = keccak256("fake");
        vm.prank(caller);
        vm.expectRevert(StableFXBridge.NotOrchestrator.selector);
        bridge.completeSwap(fakeSwapId);
    }

    // ─── updateOrchestrator Tests ────────────────────────────────────────────────

    function testUpdateOrchestratorChangesAddress() public {
        address newOrchestrator = makeAddr("newOrchestrator");
        vm.prank(owner);
        bridge.updateOrchestrator(newOrchestrator);
        assertEq(bridge.orchestrator(), newOrchestrator);
    }

    function testUpdateOrchestratorEmitsEvent() public {
        address newOrchestrator = makeAddr("newOrchestrator");
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit StableFXBridge.OrchestratorUpdated(orchestrator, newOrchestrator);
        bridge.updateOrchestrator(newOrchestrator);
    }

    function testUpdateOrchestratorRevertsForNonOwner() public {
        vm.prank(caller);
        vm.expectRevert(StableFXBridge.NotOwner.selector);
        bridge.updateOrchestrator(makeAddr("newOrchestrator"));
    }

    function testUpdateOrchestratorRevertsForZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(StableFXBridge.ZeroAddress.selector);
        bridge.updateOrchestrator(address(0));
    }

    // ─── Integration: Payment_Router-like flow ───────────────────────────────────

    function testFullPreFundedSwapFlow() public {
        // Simulate the full flow:
        // 1. Orchestrator pre-funds EURC for recipient
        // 2. Payment_Router (caller) calls swap with USDC input
        // 3. Recipient receives EURC, bridge holds USDC

        uint256 preFundAmount = 920e6; // Orchestrator pre-funds based on RFQ quote
        uint256 swapAmountIn = 1000e6;
        uint256 minAmountOut = 900e6;

        // Step 1: Orchestrator pre-funds
        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), preFundAmount);
        bridge.preFund(recipient, address(eurc), preFundAmount);
        vm.stopPrank();

        // Step 2: Caller (Payment_Router) executes swap
        vm.startPrank(caller);
        usdc.approve(address(bridge), swapAmountIn);
        uint256 amountOut = bridge.swap(address(usdc), address(eurc), swapAmountIn, minAmountOut, recipient);
        vm.stopPrank();

        // Step 3: Verify final state
        assertEq(amountOut, preFundAmount);
        assertEq(eurc.balanceOf(recipient), preFundAmount);
        assertEq(usdc.balanceOf(address(bridge)), swapAmountIn);
        assertEq(bridge.preFundedBalances(recipient, address(eurc)), 0);
    }

    // ─── Gas Bound Test ──────────────────────────────────────────────────────────

    function testSwapGasConsumptionUnder400k() public {
        uint256 preFundAmount = 950e6;
        uint256 swapAmountIn = 1000e6;

        vm.startPrank(orchestrator);
        eurc.approve(address(bridge), preFundAmount);
        bridge.preFund(recipient, address(eurc), preFundAmount);
        vm.stopPrank();

        vm.startPrank(caller);
        usdc.approve(address(bridge), swapAmountIn);

        uint256 gasBefore = gasleft();
        bridge.swap(address(usdc), address(eurc), swapAmountIn, 900e6, recipient);
        uint256 gasUsed = gasBefore - gasleft();
        vm.stopPrank();

        assertLt(gasUsed, 400_000, "swap() must use less than 400k gas");
    }
}
