// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {WizPaySwapExecutor, IXyloRouter} from "src/WizPaySwapExecutor.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

contract MockXyloRouter is IXyloRouter {
    uint256 public amountOutBps = 9_800;
    bool public returnBelowMinWithoutReverting;
    uint256 public lastAmountIn;
    uint256 public lastMinAmountOut;
    uint256 public lastAmountOut;
    address public lastTokenIn;
    address public lastTokenOut;
    address public lastTo;
    uint256 public lastDeadline;

    function setAmountOutBps(uint256 nextAmountOutBps) external {
        amountOutBps = nextAmountOutBps;
    }

    function setReturnBelowMinWithoutReverting(bool enabled) external {
        returnBelowMinWithoutReverting = enabled;
    }

    function getAmountOut(address, address, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        return (amountIn * amountOutBps) / 10_000;
    }

    function swap(SwapParams calldata params) external returns (uint256 amountOut) {
        amountOut = (params.amountIn * amountOutBps) / 10_000;
        if (amountOut < params.minAmountOut && !returnBelowMinWithoutReverting) {
            revert("XYLO_MIN_AMOUNT_OUT");
        }

        lastTokenIn = params.tokenIn;
        lastTokenOut = params.tokenOut;
        lastAmountIn = params.amountIn;
        lastMinAmountOut = params.minAmountOut;
        lastTo = params.to;
        lastDeadline = params.deadline;
        lastAmountOut = amountOut;

        MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        MockERC20(params.tokenOut).transfer(params.to, amountOut);
    }
}

contract WizPaySwapExecutorTest is Test {
    event Approval(address indexed owner, address indexed spender, uint256 value);

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

    uint256 internal constant INITIAL_SUPPLY = 1_000_000e6;
    uint256 internal constant FEE_BPS = 25;

    WizPaySwapExecutor internal executor;
    MockXyloRouter internal router;
    MockXyloRouter internal otherRouter;
    MockERC20 internal usdc;
    MockERC20 internal eurc;
    MockERC20 internal rnd;

    address internal owner = address(this);
    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");
    address internal feeRecipient = makeAddr("fee-recipient");
    address internal rescueRecipient = makeAddr("rescue-recipient");
    address internal nonOwner = makeAddr("non-owner");

    function setUp() public {
        usdc = new MockERC20("Mock USD Coin", "USDC", 6, INITIAL_SUPPLY);
        eurc = new MockERC20("Mock Euro Coin", "EURC", 6, INITIAL_SUPPLY);
        rnd = new MockERC20("Random Token", "RND", 6, INITIAL_SUPPLY);
        router = new MockXyloRouter();
        otherRouter = new MockXyloRouter();
        executor = new WizPaySwapExecutor(owner, feeRecipient, FEE_BPS);

        executor.setTokenAllowed(address(usdc), true);
        executor.setTokenAllowed(address(eurc), true);
        executor.setRouterAllowed(address(router), true);

        usdc.transfer(user, 10_000e6);
        eurc.transfer(user, 10_000e6);
        usdc.transfer(address(router), 100_000e6);
        eurc.transfer(address(router), 100_000e6);
    }

    function testSuccessfulUsdcToEurcSwap() public {
        uint256 amountIn = 1_000e6;
        uint256 feeAmount = 2_500_000;
        uint256 netAmountIn = amountIn - feeAmount;
        uint256 minAmountOut = 950e6;
        uint256 expectedAmountOut = 977_550_000;
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(user);
        usdc.approve(address(executor), amountIn);

        vm.expectEmit(true, true, true, true, address(executor));
        emit WizPaySwapExecuted(
            user,
            address(router),
            address(usdc),
            address(eurc),
            amountIn,
            feeAmount,
            netAmountIn,
            expectedAmountOut,
            recipient
        );

        vm.prank(user);
        uint256 amountOut = executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            amountIn,
            minAmountOut,
            recipient,
            deadline
        );

        assertEq(amountOut, expectedAmountOut);
        assertEq(usdc.balanceOf(feeRecipient), feeAmount);
        assertEq(usdc.balanceOf(address(router)), 100_000e6 + netAmountIn);
        assertEq(eurc.balanceOf(recipient), expectedAmountOut);
        assertEq(router.lastAmountIn(), netAmountIn);
        assertEq(router.lastMinAmountOut(), minAmountOut);
        assertEq(router.lastTokenIn(), address(usdc));
        assertEq(router.lastTokenOut(), address(eurc));
        assertEq(router.lastTo(), recipient);
        assertEq(router.lastDeadline(), deadline);
        assertEq(router.lastAmountOut(), expectedAmountOut);
    }

    function testSuccessfulEurcToUsdcSwap() public {
        uint256 amountIn = 2_000e6;
        uint256 feeAmount = 5_000_000;
        uint256 netAmountIn = amountIn - feeAmount;
        uint256 expectedAmountOut = 1_955_100_000;

        vm.prank(user);
        eurc.approve(address(executor), amountIn);

        vm.prank(user);
        uint256 amountOut = executor.executeSwap(
            address(router),
            address(eurc),
            address(usdc),
            amountIn,
            1_900e6,
            recipient,
            block.timestamp + 1 hours
        );

        assertEq(amountOut, expectedAmountOut);
        assertEq(eurc.balanceOf(feeRecipient), feeAmount);
        assertEq(usdc.balanceOf(recipient), expectedAmountOut);
        assertEq(router.lastAmountIn(), netAmountIn);
    }

    function testRevertsWhenTokenInIsNotAllowlisted() public {
        vm.prank(user);
        rnd.approve(address(executor), 1_000e6);

        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutor.TokenNotAllowlisted.selector, address(rnd)));
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(rnd),
            address(eurc),
            1_000e6,
            900e6,
            recipient,
            block.timestamp + 1 hours
        );
    }

    function testRevertsWhenTokenOutIsNotAllowlisted() public {
        vm.prank(user);
        usdc.approve(address(executor), 1_000e6);

        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutor.TokenNotAllowlisted.selector, address(rnd)));
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(rnd),
            1_000e6,
            900e6,
            recipient,
            block.timestamp + 1 hours
        );
    }

    function testRevertsWhenRouterIsNotAllowlisted() public {
        vm.prank(user);
        usdc.approve(address(executor), 1_000e6);

        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutor.RouterNotAllowlisted.selector, address(otherRouter)));
        vm.prank(user);
        executor.executeSwap(
            address(otherRouter),
            address(usdc),
            address(eurc),
            1_000e6,
            900e6,
            recipient,
            block.timestamp + 1 hours
        );
    }

    function testConstructorRevertsWhenFeeRecipientIsZero() public {
        vm.expectRevert(WizPaySwapExecutor.FeeRecipientZeroAddress.selector);
        new WizPaySwapExecutor(owner, address(0), FEE_BPS);
    }

    function testRevertsWhenAmountInIsZero() public {
        vm.expectRevert(WizPaySwapExecutor.AmountMustBeGreaterThanZero.selector);
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            0,
            900e6,
            recipient,
            block.timestamp + 1 hours
        );
    }

    function testRevertsWhenMinAmountOutIsZero() public {
        vm.expectRevert(WizPaySwapExecutor.MinAmountOutZero.selector);
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            1_000e6,
            0,
            recipient,
            block.timestamp + 1 hours
        );
    }

    function testRevertsWhenRecipientIsZero() public {
        vm.expectRevert(WizPaySwapExecutor.RecipientZeroAddress.selector);
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            1_000e6,
            900e6,
            address(0),
            block.timestamp + 1 hours
        );
    }

    function testRevertsWhenDeadlineIsExpired() public {
        vm.warp(1 days);

        vm.expectRevert(
            abi.encodeWithSelector(WizPaySwapExecutor.DeadlineExpired.selector, block.timestamp - 1, block.timestamp)
        );
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            1_000e6,
            900e6,
            recipient,
            block.timestamp - 1
        );
    }

    function testRevertsWithSlippageExceededWhenRouterReturnsBelowMinimum() public {
        uint256 amountIn = 1_000e6;
        uint256 minAmountOut = 950e6;
        uint256 expectedLowAmountOut = 897_750_000;

        router.setAmountOutBps(9_000);
        router.setReturnBelowMinWithoutReverting(true);

        vm.prank(user);
        usdc.approve(address(executor), amountIn);

        vm.expectRevert(
            abi.encodeWithSelector(
                WizPaySwapExecutor.SlippageExceeded.selector,
                expectedLowAmountOut,
                minAmountOut
            )
        );
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            amountIn,
            minAmountOut,
            recipient,
            block.timestamp + 1 hours
        );
    }

    function testRevertsWhenPaused() public {
        executor.pause();

        vm.expectRevert();
        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            1_000e6,
            900e6,
            recipient,
            block.timestamp + 1 hours
        );
    }

    function testConstructorRevertsWhenFeeBpsExceedsMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutor.FeeExceedsMaximum.selector, 101, 100));
        new WizPaySwapExecutor(owner, feeRecipient, 101);
    }

    function testOwnerCanUpdateFeeBpsWithinCap() public {
        executor.setFeeBps(50);
        assertEq(executor.feeBps(), 50);
    }

    function testSetFeeBpsRevertsWhenFeeExceedsMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutor.FeeExceedsMaximum.selector, 101, 100));
        executor.setFeeBps(101);
    }

    function testOwnerCanUpdateFeeRecipient() public {
        address nextFeeRecipient = makeAddr("next-fee-recipient");

        executor.setFeeRecipient(nextFeeRecipient);

        assertEq(executor.feeRecipient(), nextFeeRecipient);
    }

    function testSetFeeRecipientRevertsForZeroAddress() public {
        vm.expectRevert(WizPaySwapExecutor.FeeRecipientZeroAddress.selector);
        executor.setFeeRecipient(address(0));
    }

    function testOwnerCanUpdateTokenAllowlist() public {
        executor.setTokenAllowed(address(rnd), true);
        assertTrue(executor.allowedTokens(address(rnd)));

        executor.setTokenAllowed(address(rnd), false);
        assertFalse(executor.allowedTokens(address(rnd)));
    }

    function testSetTokenAllowedRevertsForZeroAddress() public {
        vm.expectRevert(WizPaySwapExecutor.TokenZeroAddress.selector);
        executor.setTokenAllowed(address(0), true);
    }

    function testOwnerCanUpdateRouterAllowlist() public {
        executor.setRouterAllowed(address(otherRouter), true);
        assertTrue(executor.allowedRouters(address(otherRouter)));

        executor.setRouterAllowed(address(otherRouter), false);
        assertFalse(executor.allowedRouters(address(otherRouter)));
    }

    function testSetRouterAllowedRevertsForZeroAddress() public {
        vm.expectRevert(WizPaySwapExecutor.RouterZeroAddress.selector);
        executor.setRouterAllowed(address(0), true);
    }

    function testRescueTokensOwnerOnlyBehavior() public {
        usdc.transfer(address(executor), 123e6);

        executor.rescueTokens(address(usdc), rescueRecipient, 123e6);

        assertEq(usdc.balanceOf(rescueRecipient), 123e6);
    }

    function testRescueTokensRevertsForNonOwner() public {
        usdc.transfer(address(executor), 123e6);

        vm.expectRevert();
        vm.prank(nonOwner);
        executor.rescueTokens(address(usdc), rescueRecipient, 123e6);
    }

    function testNonOwnerAdminCallsRevert() public {
        vm.startPrank(nonOwner);

        vm.expectRevert();
        executor.setFeeBps(1);

        vm.expectRevert();
        executor.setFeeRecipient(nonOwner);

        vm.expectRevert();
        executor.setTokenAllowed(address(rnd), true);

        vm.expectRevert();
        executor.setRouterAllowed(address(otherRouter), true);

        vm.expectRevert();
        executor.pause();

        vm.stopPrank();
    }

    function testApprovalResetBeforeSet() public {
        uint256 amountIn = 1_000e6;
        uint256 feeAmount = 2_500_000;
        uint256 netAmountIn = amountIn - feeAmount;

        vm.prank(user);
        usdc.approve(address(executor), amountIn);

        vm.expectEmit(true, true, true, true, address(usdc));
        emit Approval(address(executor), address(router), 0);
        vm.expectEmit(true, true, true, true, address(usdc));
        emit Approval(address(executor), address(router), netAmountIn);

        vm.prank(user);
        executor.executeSwap(
            address(router),
            address(usdc),
            address(eurc),
            amountIn,
            900e6,
            recipient,
            block.timestamp + 1 hours
        );
    }
}
