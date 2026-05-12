// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StableFXAdapter_V2} from "src/StableFXAdapter_V2.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

contract StableFXAdapterV2Test is Test {
    uint256 internal constant INITIAL_SUPPLY = 1_000_000e6;
    uint256 internal constant PARITY_RATE = 1e18;

    StableFXAdapter_V2 internal adapter;
    MockERC20 internal usdc;
    MockERC20 internal eurc;
    MockERC20 internal rnd;

    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    function setUp() public {
        usdc = new MockERC20("Mock USD Coin", "USDC", 6, INITIAL_SUPPLY);
        eurc = new MockERC20("Mock Euro Coin", "EURC", 6, INITIAL_SUPPLY);
        rnd = new MockERC20("Random Token", "RND", 6, INITIAL_SUPPLY);

        adapter = new StableFXAdapter_V2(address(this), address(usdc));
        adapter.addAcceptedToken(address(usdc));
        adapter.addAcceptedToken(address(eurc));
        adapter.setExchangeRate(address(usdc), address(eurc), PARITY_RATE);
        adapter.setExchangeRate(address(eurc), address(usdc), PARITY_RATE);

        usdc.transfer(lp, 100_000e6);
        eurc.transfer(lp, 100_000e6);
        usdc.transfer(trader, 10_000e6);
        rnd.transfer(trader, 10_000e6);

        vm.startPrank(lp);
        usdc.approve(address(adapter), type(uint256).max);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 50_000e6);
        adapter.addLiquidity(address(eurc), 50_000e6);
        vm.stopPrank();
    }

    function testAddLiquidityMintsProportionalShares() public {
        assertEq(adapter.balanceOf(lp), 100_000e6);
        assertEq(adapter.totalSupply(), 100_000e6);
        assertEq(adapter.getTVL(), 100_000e6);
    }

    function testSwapRevertsForUnacceptedInputToken() public {
        vm.startPrank(trader);
        rnd.approve(address(adapter), 1_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(StableFXAdapter_V2.TokenNotAccepted.selector, address(rnd))
        );
        adapter.swap(address(rnd), address(usdc), 1_000e6, 900e6, trader);
        vm.stopPrank();
    }

    function testSwapTransfersQuotedOutputLessLpFee() public {
        vm.startPrank(trader);
        usdc.approve(address(adapter), 1_000e6);

        uint256 amountOut = adapter.swap(address(usdc), address(eurc), 1_000e6, 997_500_000, trader);

        vm.stopPrank();

        assertEq(amountOut, 997_500_000);
        assertEq(eurc.balanceOf(trader), 997_500_000);
    }

    function testRemoveLiquidityBurnsSharesBeforePayout() public {
        uint256 sharesToBurn = 25_000e6;
        // LP's last deposit was EURC, so same-asset redemption enforces EURC withdrawal.
        // Pro-rata: 25_000e6 shares * 50_000e6 poolLedger[EURC] / 100_000e6 totalSupply = 12_500e6
        uint256 eurcBefore = eurc.balanceOf(lp);

        vm.prank(lp);
        adapter.removeLiquidity(address(eurc), sharesToBurn);

        assertEq(adapter.balanceOf(lp), 75_000e6);
        assertEq(eurc.balanceOf(lp), eurcBefore + 12_500e6);
    }
}
