// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WizPaySwapExecutorV2, IXyloRouterV2} from "src/WizPaySwapExecutorV2.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

contract MockXyloRouterV2 is IXyloRouterV2 {
    uint256 public amountOutBps = 9_800;
    uint256 public spendBps = 10_000;
    int256 public reportedAmountOffset;
    address public redirectRecipient;

    function configure(
        uint256 nextAmountOutBps,
        uint256 nextSpendBps,
        int256 nextReportedAmountOffset,
        address nextRedirectRecipient
    ) external {
        amountOutBps = nextAmountOutBps;
        spendBps = nextSpendBps;
        reportedAmountOffset = nextReportedAmountOffset;
        redirectRecipient = nextRedirectRecipient;
    }

    function swap(SwapParams calldata params) external returns (uint256 amountOut) {
        uint256 spent = (params.amountIn * spendBps) / 10_000;
        amountOut = (spent * amountOutBps) / 10_000;
        MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), spent);
        MockERC20(params.tokenOut).transfer(redirectRecipient == address(0) ? params.to : redirectRecipient, amountOut);

        if (reportedAmountOffset > 0) return amountOut + uint256(reportedAmountOffset);
        if (reportedAmountOffset < 0) return amountOut - uint256(-reportedAmountOffset);
    }
}

contract MockSmartContractAccount {
    function approveAndSwap(
        IERC20 token,
        WizPaySwapExecutorV2 executor,
        address router,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external returns (uint256) {
        token.approve(address(executor), amountIn);
        return executor.executeSwap(router, address(token), tokenOut, amountIn, minAmountOut, address(this), deadline);
    }
}

contract ReentrantRouterV2 is IXyloRouterV2 {
    WizPaySwapExecutorV2 internal immutable executor;

    constructor(WizPaySwapExecutorV2 executor_) {
        executor = executor_;
    }

    function swap(SwapParams calldata params) external returns (uint256) {
        executor.executeSwap(address(this), params.tokenIn, params.tokenOut, 1, 1, address(this), params.deadline);
        return 0;
    }
}

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

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract WizPaySwapExecutorV2Test is Test {
    uint256 internal constant SUPPLY = 1_000_000e6;
    uint256 internal constant AMOUNT_IN = 1_000e6;
    uint256 internal constant FEE = 2_500_000;
    address internal constant SAFE = address(0xA11CE);

    WizPaySwapExecutorV2 internal executor;
    MockXyloRouterV2 internal router;
    MockERC20 internal usdc;
    MockERC20 internal eurc;
    address internal user = makeAddr("user");

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6, SUPPLY);
        eurc = new MockERC20("EURC", "EURC", 6, SUPPLY);
        router = new MockXyloRouterV2();
        executor = new WizPaySwapExecutorV2(SAFE, SAFE, 25);

        vm.startPrank(SAFE);
        executor.setTokenAllowed(address(usdc), true);
        executor.setTokenAllowed(address(eurc), true);
        executor.setRouterAllowed(address(router), true);
        vm.stopPrank();

        usdc.transfer(user, 10_000e6);
        eurc.transfer(address(router), 100_000e6);
    }

    function testUserControlledEoaCallerAndFeeRecipient() public {
        _approve(user, usdc, AMOUNT_IN);
        vm.prank(user);
        uint256 amountOut = executor.executeSwap(
            address(router), address(usdc), address(eurc), AMOUNT_IN, 900e6, user, block.timestamp + 10 minutes
        );

        assertEq(amountOut, 977_550_000);
        assertEq(usdc.balanceOf(SAFE), FEE);
        assertEq(eurc.balanceOf(user), amountOut);
        assertEq(usdc.allowance(address(executor), address(router)), 0);
        assertEq(usdc.balanceOf(address(executor)), 0);
    }

    function testSmartContractAccountCaller() public {
        MockSmartContractAccount account = new MockSmartContractAccount();
        usdc.transfer(address(account), AMOUNT_IN);

        uint256 amountOut = account.approveAndSwap(
            IERC20(address(usdc)),
            executor,
            address(router),
            address(eurc),
            AMOUNT_IN,
            900e6,
            block.timestamp + 10 minutes
        );
        assertEq(eurc.balanceOf(address(account)), amountOut);
    }

    function testRejectsRecipientMismatch() public {
        _approve(user, usdc, AMOUNT_IN);
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.RecipientMustEqualCaller.selector, other, user));
        vm.prank(user);
        executor.executeSwap(
            address(router), address(usdc), address(eurc), AMOUNT_IN, 1, other, block.timestamp + 10 minutes
        );
    }

    function testRejectsZeroRecipientAmountAndMinimum() public {
        vm.startPrank(user);
        vm.expectRevert(WizPaySwapExecutorV2.AmountMustBeGreaterThanZero.selector);
        executor.executeSwap(address(router), address(usdc), address(eurc), 0, 1, user, block.timestamp + 1);
        vm.expectRevert(WizPaySwapExecutorV2.MinAmountOutZero.selector);
        executor.executeSwap(address(router), address(usdc), address(eurc), 1, 0, user, block.timestamp + 1);
        vm.expectRevert(WizPaySwapExecutorV2.RecipientZeroAddress.selector);
        executor.executeSwap(address(router), address(usdc), address(eurc), 1, 1, address(0), block.timestamp + 1);
        vm.stopPrank();
    }

    function testRejectsExpiredAndExcessiveDeadline() public {
        vm.warp(100);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.DeadlineExpired.selector, 99, 100));
        vm.prank(user);
        executor.executeSwap(address(router), address(usdc), address(eurc), 1, 1, user, 99);

        uint256 maximum = block.timestamp + executor.MAX_DEADLINE_WINDOW();
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.DeadlineTooFar.selector, maximum + 1, maximum));
        vm.prank(user);
        executor.executeSwap(address(router), address(usdc), address(eurc), 1, 1, user, maximum + 1);
    }

    function testRejectsNonAllowlistedRouterAndToken() public {
        address unknown = makeAddr("unknown");
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.RouterNotAllowlisted.selector, unknown));
        vm.prank(user);
        executor.executeSwap(unknown, address(usdc), address(eurc), 1, 1, user, block.timestamp + 1);

        MockERC20 other = new MockERC20("OTHER", "OTHER", 6, 10);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.TokenNotAllowlisted.selector, address(other)));
        vm.prank(user);
        executor.executeSwap(address(router), address(other), address(eurc), 1, 1, user, block.timestamp + 1);
    }

    function testRejectsInsufficientActualOutputAndRedirectedOutput() public {
        _approve(user, usdc, AMOUNT_IN);
        router.configure(8_000, 10_000, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.SlippageExceeded.selector, 798_000_000, 900e6));
        vm.prank(user);
        executor.executeSwap(
            address(router), address(usdc), address(eurc), AMOUNT_IN, 900e6, user, block.timestamp + 10 minutes
        );

        router.configure(9_800, 10_000, 0, makeAddr("attacker"));
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.RouterAmountOutMismatch.selector, 977_550_000, 0));
        vm.prank(user);
        executor.executeSwap(
            address(router), address(usdc), address(eurc), AMOUNT_IN, 900e6, user, block.timestamp + 10 minutes
        );
    }

    function testRejectsPartialSpendAndRollsBack() public {
        _approve(user, usdc, AMOUNT_IN);
        router.configure(9_800, 5_000, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.ResidualInputBalance.selector, 0, 498_750_000));
        vm.prank(user);
        executor.executeSwap(
            address(router), address(usdc), address(eurc), AMOUNT_IN, 1, user, block.timestamp + 10 minutes
        );
        assertEq(usdc.balanceOf(user), 10_000e6);
        assertEq(usdc.balanceOf(SAFE), 0);
    }

    function testRejectsFalseReturnToken() public {
        FalseReturnToken token = new FalseReturnToken();
        token.mint(user, AMOUNT_IN);
        vm.prank(SAFE);
        executor.setTokenAllowed(address(token), true);
        vm.prank(user);
        token.approve(address(executor), AMOUNT_IN);

        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        vm.prank(user);
        executor.executeSwap(address(router), address(token), address(eurc), AMOUNT_IN, 1, user, block.timestamp + 1);
    }

    function testReentrancyAndPause() public {
        ReentrantRouterV2 reentrant = new ReentrantRouterV2(executor);
        vm.prank(SAFE);
        executor.setRouterAllowed(address(reentrant), true);
        _approve(user, usdc, AMOUNT_IN);
        vm.expectRevert();
        vm.prank(user);
        executor.executeSwap(address(reentrant), address(usdc), address(eurc), AMOUNT_IN, 1, user, block.timestamp + 1);

        vm.prank(SAFE);
        executor.pause();
        vm.expectRevert();
        vm.prank(user);
        executor.executeSwap(address(router), address(usdc), address(eurc), 1, 1, user, block.timestamp + 1);
    }

    function testSafeOwnsAdministrationAndActiveTokenCannotBeRescued() public {
        assertEq(executor.owner(), SAFE);
        assertEq(executor.feeRecipient(), SAFE);
        assertEq(executor.feeBps(), 25);
        vm.expectRevert();
        executor.pause();

        vm.startPrank(SAFE);
        vm.expectRevert(WizPaySwapExecutorV2.OwnershipLocked.selector);
        executor.transferOwnership(user);
        vm.expectRevert(WizPaySwapExecutorV2.OwnershipLocked.selector);
        executor.renounceOwnership();
        vm.stopPrank();

        usdc.transfer(address(executor), 10);
        vm.startPrank(SAFE);
        executor.pause();
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorV2.TokenRescueBlocked.selector, address(usdc)));
        executor.rescueTokens(address(usdc), SAFE, 10);
        executor.setTokenAllowed(address(usdc), false);
        executor.rescueTokens(address(usdc), SAFE, 10);
        vm.stopPrank();
    }

    function testConstructorRequiresFeeRecipientToEqualOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(WizPaySwapExecutorV2.FeeRecipientMustEqualOwner.selector, address(2), address(1))
        );
        new WizPaySwapExecutorV2(address(1), address(2), 25);
    }

    function _approve(address account, MockERC20 token, uint256 amount) internal {
        vm.prank(account);
        token.approve(address(executor), amount);
    }
}
