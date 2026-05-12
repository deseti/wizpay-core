// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StableFXAdapter_V2} from "src/StableFXAdapter_V2.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

/**
 * @title Bug Condition Exploration Tests
 * @notice These tests encode the EXPECTED behavior for StableFXAdapter_V2 after the fix.
 *         They are designed to FAIL on the unfixed code, proving the 8 accounting bugs exist.
 *         When the fix is implemented, these tests should PASS.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */
contract StableFXAdapterV2BugExplorationTest is Test {
    uint256 internal constant INITIAL_SUPPLY = 10_000_000e6;

    StableFXAdapter_V2 internal adapter;
    MockERC20 internal usdc;
    MockERC20 internal eurc;

    address internal owner = address(this);
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new MockERC20("Mock USD Coin", "USDC", 6, INITIAL_SUPPLY);
        eurc = new MockERC20("Mock Euro Coin", "EURC", 6, INITIAL_SUPPLY);

        adapter = new StableFXAdapter_V2(owner, address(usdc));
        adapter.addAcceptedToken(address(usdc));
        adapter.addAcceptedToken(address(eurc));

        // Set rates: USDC→EURC at 1.08 (1 USDC = 1.08 EURC)
        adapter.setExchangeRate(address(usdc), address(eurc), 1.08e18);
        adapter.setExchangeRate(address(eurc), address(usdc), 0.926e18); // ~1/1.08

        // Fund LPs
        usdc.transfer(lp1, 500_000e6);
        eurc.transfer(lp1, 500_000e6);
        usdc.transfer(lp2, 500_000e6);
        eurc.transfer(lp2, 500_000e6);
        usdc.transfer(attacker, 500_000e6);
        eurc.transfer(attacker, 500_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 1 - DOUBLE CONVERSION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 1: Double conversion in removeLiquidity
     * @dev LP deposits USDC, calls removeLiquidity(USDC, shares).
     *      Expected: withdrawal equals shares * poolLedger[USDC] / totalSupply (single pro-rata).
     *      On unfixed code: double conversion through getEstimatedAmountInternal inflated amounts.
     *      On fixed code: same-asset redemption enforced, single pro-rata calculation used.
     *
     * Validates: Requirements 1.1
     */
    function test_bug1_doubleConversion() public {
        // LP1 deposits USDC
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 50_000e6);
        vm.stopPrank();

        // LP2 deposits EURC
        vm.startPrank(lp2);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(eurc), 50_000e6);
        vm.stopPrank();

        uint256 lp1Shares = adapter.balanceOf(lp1);
        uint256 totalShares = adapter.totalSupply();
        uint256 usdcPoolLedger = adapter.poolLedger(address(usdc));

        // Expected: pro-rata share of USDC pool = shares * poolLedger[USDC] / totalSupply
        uint256 expectedProRata = (lp1Shares * usdcPoolLedger) / totalShares;

        uint256 usdcBefore = usdc.balanceOf(lp1);

        // LP1 withdraws in USDC (same-asset redemption enforced)
        vm.prank(lp1);
        adapter.removeLiquidity(address(usdc), lp1Shares);

        uint256 usdcReceived = usdc.balanceOf(lp1) - usdcBefore;

        // Assert single pro-rata: withdrawal should equal shares * poolLedger[USDC] / totalSupply
        // No double conversion — just a direct pro-rata calculation against internal ledger
        assertEq(
            usdcReceived,
            expectedProRata,
            "Bug 1: Double conversion detected - withdrawal does not match pro-rata share"
        );
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 2 - RECIPROCAL ARBITRAGE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 2: Reciprocal rate invariant violation enables arbitrage
     * @dev Set USDC→EURC=1.08e18, then attempt EURC→USDC=0.95e18 (product=1.026≠1.0).
     *      Assert the system rejects the inconsistent rate with ReciprocalInvariantViolation.
     *      On unfixed code: any rate accepted, enabling arbitrage extraction.
     *      On fixed code: reciprocal invariant enforced, inconsistent rates rejected.
     *
     * Validates: Requirements 1.2
     */
    function test_bug2_reciprocalArbitrage() public {
        // Set USDC→EURC rate (this succeeds as it's consistent with setUp's 0.926 inverse)
        adapter.setExchangeRate(address(usdc), address(eurc), 1.08e18);

        // Attempt to set inconsistent inverse rate: product = 1.08 * 0.95 = 1.026 > 1.01 tolerance
        // On fixed code, this should revert with ReciprocalInvariantViolation
        vm.expectRevert();
        adapter.setExchangeRate(address(eurc), address(usdc), 0.95e18);
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 3 - DONATION INFLATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 3: Donation attack inflates TVL via balanceOf()
     * @dev Send 100k tokens directly to contract, then deposit.
     *      Assert shares minted use internal ledger not balanceOf().
     *      On unfixed code: shares are diluted by donation.
     *
     * Validates: Requirements 1.3
     */
    function test_bug3_donationInflation() public {
        // LP1 deposits first to establish baseline
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 50_000e6);
        vm.stopPrank();

        // Record TVL before donation
        uint256 tvlBeforeDonation = adapter.getTVL();

        // Attacker donates 100k USDC directly to contract (not via addLiquidity)
        vm.prank(attacker);
        usdc.transfer(address(adapter), 100_000e6);

        // Record TVL after donation
        uint256 tvlAfterDonation = adapter.getTVL();

        // Assert TVL is NOT inflated by donation (should use internal ledger)
        // On unfixed code, TVL uses balanceOf() which includes the donation
        assertEq(
            tvlAfterDonation,
            tvlBeforeDonation,
            "Bug 3: Donation inflation detected - TVL increased from direct transfer"
        );
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 4 - RATE ISOLATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 4: Single expired rate blocks all operations
     * @dev Expire one token's rate, attempt removeLiquidity for unaffected token.
     *      Assert no revert. On unfixed code: getTVL() reverts blocking all operations.
     *
     * Validates: Requirements 1.4
     */
    function test_bug4_rateIsolation() public {
        // LP1 deposits USDC
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 50_000e6);
        vm.stopPrank();

        // LP2 deposits EURC
        vm.startPrank(lp2);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(eurc), 50_000e6);
        vm.stopPrank();

        // Fast-forward time to expire the EURC→USDC rate (1 year + 1 second)
        vm.warp(block.timestamp + 365 days + 1);

        // Only refresh USDC→EURC rate (leave EURC→USDC expired)
        adapter.setExchangeRate(address(usdc), address(eurc), 1.08e18);

        // LP1 should be able to withdraw USDC even though EURC rate is expired
        // On unfixed code, getTVL() reverts because it iterates all tokens
        uint256 lp1Shares = adapter.balanceOf(lp1);
        vm.prank(lp1);
        adapter.removeLiquidity(address(usdc), lp1Shares);

        // If we reach here, rate isolation works
        assertTrue(true, "Bug 4: Rate isolation working - unaffected token withdrawal succeeded");
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 5 - RATE BOUNDS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 5: Unbounded rate updates accepted
     * @dev Set rate with >10% deviation from previous. Assert revert with bounds violation.
     *      On unfixed code: any rate is accepted.
     *
     * Validates: Requirements 1.5
     */
    function test_bug5_rateBounds() public {
        // Set initial rate
        adapter.setExchangeRate(address(usdc), address(eurc), 1.08e18);

        // Attempt to set rate with >10% deviation (50% increase: 1.08 → 1.62)
        // This should revert with a bounds violation on fixed code
        vm.expectRevert();
        adapter.setExchangeRate(address(usdc), address(eurc), 1.62e18);
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 6 - SOLVENCY
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 6: No solvency enforcement on withdrawals
     * @dev Attempt withdrawal that would leave pool below minimum reserve.
     *      Assert solvency constraint enforced.
     *      On unfixed code: no reserve enforcement exists.
     *
     * Validates: Requirements 1.6
     */
    function test_bug6_solvency() public {
        // LP1 deposits a large amount of USDC (95% of pool)
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 95_000e6);
        vm.stopPrank();

        // LP2 deposits a small amount of USDC (5% of pool)
        vm.startPrank(lp2);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 5_000e6);
        vm.stopPrank();

        uint256 lp1Shares = adapter.balanceOf(lp1);

        // LP1 tries to withdraw 99% of their shares (not full withdrawal)
        // poolLedger[USDC] = 100_000e6, LP1 shares = 95_000e6 out of 100_000e6 total
        // amountOut = (94050e6 * 100_000e6) / 100_000e6 = 94_050e6
        // remaining = 100_000e6 - 94_050e6 = 5_950e6
        // minRequired = 100_000e6 * 1000 / 10000 = 10_000e6
        // remaining (5_950e6) < minRequired (10_000e6) → REVERT
        uint256 sharesToWithdraw = (lp1Shares * 99) / 100;

        // On fixed code, this should revert with solvency constraint violation
        // On unfixed code, this succeeds (no reserve enforcement)
        vm.prank(lp1);
        vm.expectRevert();
        adapter.removeLiquidity(address(usdc), sharesToWithdraw);
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 7 - FEE SEPARATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 7: Fees conflated with principal in accounting
     * @dev Execute swaps to accrue fees, verify fees tracked in accruedFees mapping
     *      separately from poolLedger. On unfixed code: fees are conflated with principal.
     *
     * Validates: Requirements 1.7
     */
    function test_bug7_feeSeparation() public {
        // Seed pool
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 100_000e6);
        adapter.addLiquidity(address(eurc), 100_000e6);
        vm.stopPrank();

        // Execute swaps to accrue fees
        vm.startPrank(attacker);
        usdc.approve(address(adapter), type(uint256).max);
        eurc.approve(address(adapter), type(uint256).max);

        // Do multiple swaps to accrue meaningful fees
        for (uint256 i = 0; i < 10; i++) {
            adapter.swap(address(usdc), address(eurc), 10_000e6, 0, attacker);
            uint256 eurcBal = eurc.balanceOf(attacker);
            if (eurcBal > 10_000e6) {
                adapter.swap(address(eurc), address(usdc), 10_000e6, 0, attacker);
            }
        }
        vm.stopPrank();

        // On fixed code, accruedFees mapping should be populated
        // Try to access accruedFees - this will fail on unfixed code because the mapping doesn't exist
        (bool success, bytes memory data) = address(adapter).staticcall(
            abi.encodeWithSignature("accruedFees(address)", address(eurc))
        );

        assertTrue(success, "Bug 7: accruedFees mapping does not exist");
        uint256 fees = abi.decode(data, (uint256));
        assertGt(fees, 0, "Bug 7: Fee separation not implemented - no fees tracked separately");
    }

    /*//////////////////////////////////////////////////////////////
                    TEST 8 - INSUFFICIENT BALANCE DETERMINISM
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Bug 8: Non-deterministic revert on insufficient cross-asset balance
     * @dev LP requests redemption exceeding available balance for target token.
     *      Assert deterministic same-asset fallback.
     *      On unfixed code: reverts with InsufficientPoolLiquidity.
     *
     * Validates: Requirements 1.8
     */
    function test_bug8_insufficientBalanceDeterminism() public {
        // LP1 deposits large amount of USDC
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 200_000e6);
        vm.stopPrank();

        // LP2 deposits small amount of EURC
        vm.startPrank(lp2);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(eurc), 10_000e6);
        vm.stopPrank();

        uint256 lp1Shares = adapter.balanceOf(lp1);

        // LP1 deposited USDC but tries to withdraw in EURC
        // The EURC pool only has 10k but LP1's share value would require much more
        // On fixed code: should enforce same-asset redemption (revert with WrongRedemptionToken or fallback to USDC)
        // On unfixed code: reverts with InsufficientPoolLiquidity (non-deterministic)

        // The expected behavior is that the system either:
        // a) Restricts to same-asset only (reverts with WrongRedemptionToken), or
        // b) Provides a deterministic fallback
        // Either way, it should NOT revert with InsufficientPoolLiquidity

        vm.prank(lp1);
        // We expect this to NOT revert with InsufficientPoolLiquidity
        // On fixed code, it should either succeed with same-asset fallback or revert with a deterministic error
        // that is NOT InsufficientPoolLiquidity
        try adapter.removeLiquidity(address(eurc), lp1Shares) {
            // If it succeeds, the fallback mechanism worked
            assertTrue(true);
        } catch (bytes memory reason) {
            // On fixed code, should revert with WrongRedemptionToken (deterministic)
            // On unfixed code, reverts with InsufficientPoolLiquidity (non-deterministic)
            bytes4 selector = bytes4(reason);
            bytes4 insufficientLiqSelector = StableFXAdapter_V2.InsufficientPoolLiquidity.selector;

            // Assert it does NOT revert with InsufficientPoolLiquidity
            assertTrue(
                selector != insufficientLiqSelector,
                "Bug 8: Non-deterministic InsufficientPoolLiquidity revert - should have deterministic fallback"
            );
        }
    }
}
