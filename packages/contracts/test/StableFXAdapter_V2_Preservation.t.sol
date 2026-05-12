// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StableFXAdapter_V2} from "src/StableFXAdapter_V2.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

/**
 * @title Preservation Property Tests
 * @notice These tests capture the EXISTING correct behavior of StableFXAdapter_V2
 *         that must remain unchanged after the bugfix implementation.
 *         All tests MUST PASS on the unfixed code (confirming baseline behavior).
 *         After the fix, these tests MUST CONTINUE TO PASS (confirming no regressions).
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */
contract StableFXAdapterV2PreservationTest is Test {
    uint256 internal constant INITIAL_SUPPLY = 100_000_000e6;

    StableFXAdapter_V2 internal adapter;
    MockERC20 internal usdc;
    MockERC20 internal eurc;
    MockERC20 internal randomToken;

    address internal owner = address(this);
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal trader = makeAddr("trader");

    // Rate: 1 USDC = 1.08 EURC (both 6 decimals)
    uint256 internal constant USDC_EURC_RATE = 1.08e18;
    // Inverse: 1 EURC = ~0.9259 USDC (reciprocal of 1.08)
    uint256 internal constant EURC_USDC_RATE = 0.925925925925925926e18;

    function setUp() public {
        usdc = new MockERC20("Mock USD Coin", "USDC", 6, INITIAL_SUPPLY);
        eurc = new MockERC20("Mock Euro Coin", "EURC", 6, INITIAL_SUPPLY);
        randomToken = new MockERC20("Random Token", "RND", 6, INITIAL_SUPPLY);

        adapter = new StableFXAdapter_V2(owner, address(usdc));
        adapter.addAcceptedToken(address(usdc));
        adapter.addAcceptedToken(address(eurc));

        // Set consistent reciprocal rates
        adapter.setExchangeRate(address(usdc), address(eurc), USDC_EURC_RATE);
        adapter.setExchangeRate(address(eurc), address(usdc), EURC_USDC_RATE);

        // Fund participants
        usdc.transfer(lp1, 10_000_000e6);
        eurc.transfer(lp1, 10_000_000e6);
        usdc.transfer(lp2, 10_000_000e6);
        eurc.transfer(lp2, 10_000_000e6);
        usdc.transfer(trader, 10_000_000e6);
        eurc.transfer(trader, 10_000_000e6);
        randomToken.transfer(trader, 10_000_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                    PROPERTY 2.1 - SWAP OUTPUT PRESERVATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Fuzz: swap output == (amountIn * rate / 1e18) * (10000 - lpFeeBps) / 10000
     * @dev For same-decimal tokens (both 6 decimals), the formula simplifies.
     *      Swap execution must remain atomic with 0.25% LP fee.
     *
     * Validates: Requirements 3.1
     */
    function testFuzz_swapOutputPreservation(uint256 amountIn) public {
        // Bound amountIn to reasonable range: 1 unit to 1M tokens (6 decimals)
        amountIn = bound(amountIn, 1e6, 1_000_000e6);

        // Seed pool with sufficient liquidity
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 5_000_000e6);
        adapter.addLiquidity(address(eurc), 5_000_000e6);
        vm.stopPrank();

        // Compute expected output: (amountIn * rate / 1e18) then deduct 0.25% fee
        uint256 rawOutput = (amountIn * USDC_EURC_RATE) / 1e18;
        uint256 lpFee = (rawOutput * 25) / 10000;
        uint256 expectedOutput = rawOutput - lpFee;

        // Execute swap
        vm.startPrank(trader);
        usdc.approve(address(adapter), type(uint256).max);
        uint256 actualOutput = adapter.swap(
            address(usdc), address(eurc), amountIn, 0, trader
        );
        vm.stopPrank();

        // Assert output matches formula
        assertEq(
            actualOutput,
            expectedOutput,
            "Preservation: Swap output does not match expected formula"
        );
    }

    /**
     * @notice Fuzz: swap in reverse direction (EURC→USDC) also preserves formula
     *
     * Validates: Requirements 3.1
     */
    function testFuzz_swapOutputPreservationReverse(uint256 amountIn) public {
        amountIn = bound(amountIn, 1e6, 1_000_000e6);

        // Seed pool
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 5_000_000e6);
        adapter.addLiquidity(address(eurc), 5_000_000e6);
        vm.stopPrank();

        // Expected: (amountIn * EURC_USDC_RATE / 1e18) * (10000 - 25) / 10000
        uint256 rawOutput = (amountIn * EURC_USDC_RATE) / 1e18;
        uint256 lpFee = (rawOutput * 25) / 10000;
        uint256 expectedOutput = rawOutput - lpFee;

        vm.startPrank(trader);
        eurc.approve(address(adapter), type(uint256).max);
        uint256 actualOutput = adapter.swap(
            address(eurc), address(usdc), amountIn, 0, trader
        );
        vm.stopPrank();

        assertEq(
            actualOutput,
            expectedOutput,
            "Preservation: Reverse swap output does not match expected formula"
        );
    }

    /*//////////////////////////////////////////////////////////////
                    PROPERTY 2.2 - SHARE MINTING PRESERVATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Fuzz: shares minted == (valueAdded * totalSupply) / tvlBefore
     * @dev Share minting proportionality must be preserved for deposits into
     *      pools with existing liquidity.
     *
     * Validates: Requirements 3.2
     */
    function testFuzz_shareMintingPreservation(uint256 depositAmount) public {
        // Bound deposit to reasonable range
        depositAmount = bound(depositAmount, 1e6, 1_000_000e6);

        // LP1 seeds pool first
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 1_000_000e6);
        vm.stopPrank();

        // Record state before LP2 deposit
        uint256 tvlBefore = adapter.getTVL();
        uint256 totalSupplyBefore = adapter.totalSupply();

        // LP2 deposits USDC
        vm.startPrank(lp2);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), depositAmount);
        vm.stopPrank();

        // Compute expected shares: valueAdded * totalSupply / tvlBefore
        // For USDC (base asset), valueAdded == depositAmount (1:1 rate to itself)
        uint256 valueAdded = depositAmount; // USDC is base asset, rate is 1:1
        uint256 expectedShares = (valueAdded * totalSupplyBefore) / tvlBefore;

        uint256 actualShares = adapter.balanceOf(lp2);

        assertEq(
            actualShares,
            expectedShares,
            "Preservation: Share minting not proportional to value added"
        );
    }

    /**
     * @notice Fuzz: shares minted for non-base-asset deposits use rate conversion
     *
     * Validates: Requirements 3.2
     */
    function testFuzz_shareMintingNonBaseAsset(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e6, 1_000_000e6);

        // LP1 seeds pool with USDC
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 1_000_000e6);
        vm.stopPrank();

        uint256 tvlBefore = adapter.getTVL();
        uint256 totalSupplyBefore = adapter.totalSupply();

        // LP2 deposits EURC (non-base asset)
        vm.startPrank(lp2);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(eurc), depositAmount);
        vm.stopPrank();

        // valueAdded = getEstimatedAmountInternal(EURC, USDC, depositAmount)
        // = (depositAmount * EURC_USDC_RATE) / 1e18
        uint256 valueAdded = (depositAmount * EURC_USDC_RATE) / 1e18;
        uint256 expectedShares = (valueAdded * totalSupplyBefore) / tvlBefore;

        uint256 actualShares = adapter.balanceOf(lp2);

        assertEq(
            actualShares,
            expectedShares,
            "Preservation: Non-base-asset share minting incorrect"
        );
    }

    /*//////////////////////////////////////////////////////////////
                    PROPERTY 2.3 - FIRST LP INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice First LP deposit mints shares at 1:1 with base-asset-denominated value
     * @dev When totalSupply == 0, sharesToMint = valueAdded (1:1 ratio)
     *
     * Validates: Requirements 3.7
     */
    function testFuzz_firstLPInitialization(uint256 depositAmount) public {
        // Use a fresh adapter with no liquidity
        StableFXAdapter_V2 freshAdapter = new StableFXAdapter_V2(owner, address(usdc));
        freshAdapter.addAcceptedToken(address(usdc));
        freshAdapter.addAcceptedToken(address(eurc));
        freshAdapter.setExchangeRate(address(usdc), address(eurc), USDC_EURC_RATE);
        freshAdapter.setExchangeRate(address(eurc), address(usdc), EURC_USDC_RATE);

        depositAmount = bound(depositAmount, 1e6, 5_000_000e6);

        // First LP deposits USDC (base asset)
        vm.startPrank(lp1);
        usdc.approve(address(freshAdapter), type(uint256).max);
        freshAdapter.addLiquidity(address(usdc), depositAmount);
        vm.stopPrank();

        // For base asset deposit: valueAdded = depositAmount (1:1 with itself)
        // First LP: sharesToMint = valueAdded = depositAmount
        uint256 expectedShares = depositAmount;
        uint256 actualShares = freshAdapter.balanceOf(lp1);

        assertEq(
            actualShares,
            expectedShares,
            "Preservation: First LP initialization not 1:1 with base-asset value"
        );
    }

    /**
     * @notice First LP deposit with non-base-asset mints shares at 1:1 with converted value
     *
     * Validates: Requirements 3.7
     */
    function testFuzz_firstLPInitializationNonBaseAsset(uint256 depositAmount) public {
        StableFXAdapter_V2 freshAdapter = new StableFXAdapter_V2(owner, address(usdc));
        freshAdapter.addAcceptedToken(address(usdc));
        freshAdapter.addAcceptedToken(address(eurc));
        freshAdapter.setExchangeRate(address(usdc), address(eurc), USDC_EURC_RATE);
        freshAdapter.setExchangeRate(address(eurc), address(usdc), EURC_USDC_RATE);

        depositAmount = bound(depositAmount, 1e6, 5_000_000e6);

        // First LP deposits EURC (non-base asset)
        vm.startPrank(lp1);
        eurc.approve(address(freshAdapter), type(uint256).max);
        freshAdapter.addLiquidity(address(eurc), depositAmount);
        vm.stopPrank();

        // valueAdded = (depositAmount * EURC_USDC_RATE) / 1e18
        // First LP: sharesToMint = valueAdded
        uint256 expectedShares = (depositAmount * EURC_USDC_RATE) / 1e18;
        uint256 actualShares = freshAdapter.balanceOf(lp1);

        assertEq(
            actualShares,
            expectedShares,
            "Preservation: First LP non-base-asset initialization incorrect"
        );
    }

    /*//////////////////////////////////////////////////////////////
                    PROPERTY 2.4 - EMERGENCY WITHDRAWAL
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice emergencyWithdraw for non-accepted tokens works without affecting pool
     * @dev Owner can recover accidentally-sent non-pool tokens.
     *      Pool TVL and LP shares must remain unaffected.
     *
     * Validates: Requirements 3.5
     */
    function testFuzz_emergencyWithdrawPreservation(uint256 amount) public {
        amount = bound(amount, 1e6, 1_000_000e6);

        // Seed pool with liquidity
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 1_000_000e6);
        vm.stopPrank();

        uint256 tvlBefore = adapter.getTVL();
        uint256 totalSupplyBefore = adapter.totalSupply();
        uint256 lp1SharesBefore = adapter.balanceOf(lp1);

        // Send random (non-accepted) token to adapter
        vm.prank(trader);
        randomToken.transfer(address(adapter), amount);

        // Owner recovers the random token
        adapter.emergencyWithdraw(address(randomToken), amount);

        // Verify pool state unchanged
        assertEq(adapter.getTVL(), tvlBefore, "Preservation: TVL changed after emergency withdraw");
        assertEq(adapter.totalSupply(), totalSupplyBefore, "Preservation: Total supply changed");
        assertEq(adapter.balanceOf(lp1), lp1SharesBefore, "Preservation: LP shares changed");

        // Verify owner received the tokens
        assertEq(
            randomToken.balanceOf(owner),
            INITIAL_SUPPLY - 10_000_000e6 + amount,
            "Preservation: Owner did not receive emergency withdrawn tokens"
        );
    }

    /**
     * @notice emergencyWithdraw reverts for accepted pool tokens
     *
     * Validates: Requirements 3.5
     */
    function test_emergencyWithdrawRevertsForAcceptedTokens() public {
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 1_000_000e6);
        vm.stopPrank();

        // Attempting to emergency withdraw an accepted token should revert
        vm.expectRevert(
            abi.encodeWithSelector(
                StableFXAdapter_V2.AcceptedPoolTokenWithdrawalForbidden.selector,
                address(usdc)
            )
        );
        adapter.emergencyWithdraw(address(usdc), 1_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                    PROPERTY 2.5 - getEstimatedAmount PRESERVATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Fuzz: getEstimatedAmount returns fee-inclusive quote matching swap output
     * @dev External quote must equal actual swap output for same inputs.
     *
     * Validates: Requirements 3.6
     */
    function testFuzz_getEstimatedAmountPreservation(uint256 amountIn) public {
        amountIn = bound(amountIn, 1e6, 1_000_000e6);

        // Seed pool
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 5_000_000e6);
        adapter.addLiquidity(address(eurc), 5_000_000e6);
        vm.stopPrank();

        // Get estimated amount (external quote)
        uint256 estimatedOutput = adapter.getEstimatedAmount(
            address(usdc), address(eurc), amountIn
        );

        // Execute actual swap
        vm.startPrank(trader);
        usdc.approve(address(adapter), type(uint256).max);
        uint256 actualOutput = adapter.swap(
            address(usdc), address(eurc), amountIn, 0, trader
        );
        vm.stopPrank();

        // Quote must match actual output
        assertEq(
            estimatedOutput,
            actualOutput,
            "Preservation: getEstimatedAmount does not match actual swap output"
        );
    }

    /**
     * @notice getEstimatedAmount for same token returns amountIn (no fee)
     *
     * Validates: Requirements 3.6
     */
    function testFuzz_getEstimatedAmountSameToken(uint256 amountIn) public {
        amountIn = bound(amountIn, 1, type(uint128).max);

        uint256 estimated = adapter.getEstimatedAmount(
            address(usdc), address(usdc), amountIn
        );

        assertEq(estimated, amountIn, "Preservation: Same-token estimate should be 1:1");
    }

    /*//////////////////////////////////////////////////////////////
                    PROPERTY 2.6 - addAcceptedToken PRESERVATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice addAcceptedToken registers without disrupting existing accounting
     * @dev Adding a new token must not change TVL, shares, or existing token balances.
     *
     * Validates: Requirements 3.4
     */
    function test_addAcceptedTokenPreservation() public {
        // Seed pool
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 1_000_000e6);
        vm.stopPrank();

        uint256 tvlBefore = adapter.getTVL();
        uint256 totalSupplyBefore = adapter.totalSupply();
        uint256 lp1SharesBefore = adapter.balanceOf(lp1);

        // Create and add a new token
        MockERC20 newToken = new MockERC20("New Stable", "NSTB", 6, 1_000_000e6);
        adapter.addAcceptedToken(address(newToken));

        // Set rate for new token
        adapter.setExchangeRate(address(newToken), address(usdc), 1e18);
        adapter.setExchangeRate(address(usdc), address(newToken), 1e18);

        // Verify existing accounting unchanged
        assertEq(adapter.getTVL(), tvlBefore, "Preservation: TVL changed after adding token");
        assertEq(adapter.totalSupply(), totalSupplyBefore, "Preservation: Supply changed");
        assertEq(adapter.balanceOf(lp1), lp1SharesBefore, "Preservation: LP shares changed");

        // Verify new token is registered
        assertTrue(adapter.isAcceptedToken(address(newToken)), "New token not registered");
    }

    /**
     * @notice addAcceptedToken reverts for already-tracked tokens
     *
     * Validates: Requirements 3.4
     */
    function test_addAcceptedTokenRevertsForDuplicate() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                StableFXAdapter_V2.TokenAlreadyTracked.selector,
                address(usdc)
            )
        );
        adapter.addAcceptedToken(address(usdc));
    }

    /*//////////////////////////////////////////////////////////////
                    PROPERTY 2.7 - SWAP ATOMICITY & FEE RETENTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Fuzz: Swap is atomic - input pulled and output delivered in single tx
     * @dev Verifies token balances change correctly in a single transaction.
     *
     * Validates: Requirements 3.1
     */
    function testFuzz_swapAtomicity(uint256 amountIn) public {
        amountIn = bound(amountIn, 1e6, 500_000e6);

        // Seed pool
        vm.startPrank(lp1);
        usdc.approve(address(adapter), type(uint256).max);
        eurc.approve(address(adapter), type(uint256).max);
        adapter.addLiquidity(address(usdc), 5_000_000e6);
        adapter.addLiquidity(address(eurc), 5_000_000e6);
        vm.stopPrank();

        uint256 traderUsdcBefore = usdc.balanceOf(trader);
        uint256 traderEurcBefore = eurc.balanceOf(trader);
        uint256 poolEurcBefore = eurc.balanceOf(address(adapter));
        uint256 poolUsdcBefore = usdc.balanceOf(address(adapter));

        vm.startPrank(trader);
        usdc.approve(address(adapter), type(uint256).max);
        uint256 amountOut = adapter.swap(
            address(usdc), address(eurc), amountIn, 0, trader
        );
        vm.stopPrank();

        // Trader lost amountIn USDC
        assertEq(usdc.balanceOf(trader), traderUsdcBefore - amountIn);
        // Trader gained amountOut EURC
        assertEq(eurc.balanceOf(trader), traderEurcBefore + amountOut);
        // Pool gained amountIn USDC
        assertEq(usdc.balanceOf(address(adapter)), poolUsdcBefore + amountIn);
        // Pool lost amountOut EURC (fee stays in pool)
        assertEq(eurc.balanceOf(address(adapter)), poolEurcBefore - amountOut);

        // Fee retained in pool: pool lost only amountOut, not amountOut + fee
        uint256 rawOutput = (amountIn * USDC_EURC_RATE) / 1e18;
        uint256 lpFee = (rawOutput * 25) / 10000;
        // Pool EURC decreased by amountOut only (fee = rawOutput - amountOut stays)
        assertEq(rawOutput - amountOut, lpFee, "Fee not retained in pool");
    }
}
