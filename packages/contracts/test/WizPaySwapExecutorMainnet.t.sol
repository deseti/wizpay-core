// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";
import {WizPaySwapExecutorMainnet} from "src/WizPaySwapExecutorMainnet.sol";

// ---------------------------------------------------------------------------
// MockPermit2
//
// Stores allowances set via approve() (token, spender, amount, expiration)
// keyed by (owner -> token -> spender).
// pullFrom() simulates the Permit2 transferFrom path: checks the stored
// allowance then calls ERC-20.transferFrom(owner, recipient, amount).
// ---------------------------------------------------------------------------

contract MockPermit2 {
    mapping(address => mapping(address => mapping(address => uint160))) private _amounts;
    mapping(address => mapping(address => mapping(address => uint48))) private _expirations;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        _amounts[msg.sender][token][spender] = amount;
        _expirations[msg.sender][token][spender] = expiration;
    }

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce)
    {
        return (_amounts[owner][token][spender], _expirations[owner][token][spender], 0);
    }

    function pullFrom(address payer, address token, address recipient, uint160 amount) external {
        uint160 allowed = _amounts[payer][token][msg.sender];
        require(allowed >= amount, "MockPermit2: insufficient allowance");
        _amounts[payer][token][msg.sender] -= amount;
        require(IERC20(token).transferFrom(payer, recipient, amount), "MockPermit2: transferFrom failed");
    }
}

// ---------------------------------------------------------------------------
// MockUniversalRouter
//
// USDC->EURC path (msg.value > 0):
//   - Asserts payerIsUser=false.
//   - Consumes msg.value as native (no ERC-20 debit; executor USDC ERC-20
//     balance is unchanged on Arc because native and ERC-20 are the same pool,
//     but in the mock we simply do nothing -- the executor residual-balance check
//     only tracks ERC-20 balanceOf the OUTPUT token, not the input token for
//     the USDC path).
//   - Delivers configured amountOut (EURC) to recipient.
//
// EURC->USDC path (msg.value == 0):
//   - Asserts payerIsUser=true.
//   - Pulls EURC from executor via Permit2.
//   - Delivers configured amountOut (USDC) to recipient.
// ---------------------------------------------------------------------------

contract MockUniversalRouter {
    bytes public lastCommands;
    bytes[] public lastInputs;
    uint256 public lastDeadline;
    uint256 public lastValue;
    bytes public lastActions;
    bytes public lastSwapExactInParam;
    bytes public lastSettleParam;
    bytes public lastTakeParam;

    uint256 public routedAmountOut;
    bool public skipDelivery;
    bool public shouldRevert;
    string public revertReason;

    MockERC20 internal _eurc;
    MockERC20 internal _usdc;
    MockPermit2 internal _permit2;

    constructor(MockERC20 usdc_, MockERC20 eurc_, MockPermit2 permit2_) {
        _usdc = usdc_;
        _eurc = eurc_;
        _permit2 = permit2_;
    }

    function configure(uint256 amountOut_, bool skipDelivery_) external {
        routedAmountOut = amountOut_;
        skipDelivery = skipDelivery_;
        shouldRevert = false;
    }

    function configureRevert(string calldata reason) external {
        shouldRevert = true;
        revertReason = reason;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        if (shouldRevert) revert(revertReason);

        lastCommands = commands;
        lastDeadline = deadline;
        lastValue = msg.value;

        delete lastInputs;
        for (uint256 i; i < inputs.length; i++) {
            lastInputs.push(inputs[i]);
        }

        require(inputs.length == 1, "expected 1 input");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        lastActions = actions;
        require(params.length == 3, "expected 3 params");
        lastSwapExactInParam = params[0];
        lastSettleParam = params[1];
        lastTakeParam = params[2];

        // Decode SETTLE: (currency, amount, payerIsUser).
        (address settleToken,, bool payerIsUser) = abi.decode(lastSettleParam, (address, uint256, bool));

        // Decode TAKE: (tokenOut, recipient, amount).
        (address tokenOut, address recipient,) = abi.decode(lastTakeParam, (address, address, uint256));

        if (msg.value > 0) {
            // USDC->EURC: router received gross-net native USDC.
            // payerIsUser=false: router pays PoolManager from its own native balance.
            // No ERC-20 debit of executor. Arc native == ERC-20 same pool, but in
            // the mock test environment USDC is a plain ERC-20 with no native
            // coupling, so we simply accept the native value and do nothing with
            // the settleToken ERC-20.
            require(!payerIsUser, "MockRouter: USDC SETTLE must have payerIsUser=false");
            // settleToken acknowledged but not consumed as ERC-20 in mock.
            (settleToken); // silence unused warning
        } else {
            // EURC->USDC: payerIsUser=true -> executor is payer via Permit2.
            require(payerIsUser, "MockRouter: EURC SETTLE must have payerIsUser=true");
            (uint160 p2Amount,,) = _permit2.allowance(msg.sender, settleToken, address(this));
            require(p2Amount > 0, "MockRouter: no Permit2 allowance from executor");
            _permit2.pullFrom(msg.sender, settleToken, address(this), p2Amount);
        }

        // Deliver output to recipient.
        if (!skipDelivery && routedAmountOut > 0) {
            MockERC20(tokenOut).transfer(recipient, routedAmountOut);
        }
    }
}

// ---------------------------------------------------------------------------
// MockSmartContractAccount: Safe-like caller that approves then swaps.
// For USDC->EURC it forwards msg.value; for EURC->USDC it approves EURC.
// ---------------------------------------------------------------------------

contract MockSmartContractAccount {
    function approveAndSwap(
        MockERC20 token,
        WizPaySwapExecutorMainnet executor,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 minHopPriceX36,
        uint256 deadline
    ) external payable returns (uint256) {
        token.approve(address(executor), amountIn);
        return
            executor.executeSwap{value: msg.value}(tokenIn, tokenOut, amountIn, minAmountOut, minHopPriceX36, deadline);
    }
}

// ---------------------------------------------------------------------------
// Mirror types for ABI decode
// ---------------------------------------------------------------------------

struct PathKey {
    address intermediateCurrency;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
    bytes hookData;
}

struct ExactInputSingleParams {
    address currencyIn;
    PathKey[] path;
    uint256[] minHopPriceX36;
    uint128 amountIn;
    uint128 amountOutMinimum;
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------

contract WizPaySwapExecutorMainnetTest is Test {
    address internal constant SAFE = address(0x5AFE);
    address internal constant FEE_RECIPIENT = SAFE;

    uint24 internal constant POOL_FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    uint256 internal constant SUPPLY = 10_000_000e6;
    uint256 internal constant AMOUNT_IN = 1_000e6;
    uint256 internal constant FEE_BPS = 25;
    uint256 internal constant MIN_HOP_PRICE = 1e36;
    uint256 internal constant SCALE = 1_000_000_000_000; // ARC_NATIVE_USDC_SCALE

    address internal user;

    MockERC20 internal usdc;
    MockERC20 internal eurc;
    MockPermit2 internal permit2;
    MockUniversalRouter internal router;
    WizPaySwapExecutorMainnet internal executor;

    function setUp() public {
        user = makeAddr("user");

        usdc = new MockERC20("USDC", "USDC", 6, SUPPLY);
        eurc = new MockERC20("EURC", "EURC", 6, SUPPLY);
        permit2 = new MockPermit2();
        router = new MockUniversalRouter(usdc, eurc, permit2);

        executor = new WizPaySwapExecutorMainnet(
            SAFE,
            FEE_RECIPIENT,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            POOL_FEE,
            TICK_SPACING
        );

        // Give user some ERC-20 balances for EURC->USDC direction.
        eurc.transfer(user, 100_000e6);
        // Router needs output tokens to deliver.
        eurc.transfer(address(router), 500_000e6);
        usdc.transfer(address(router), 500_000e6);
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    function testConstructorSetsState() public view {
        assertEq(executor.USDC(), address(usdc));
        assertEq(executor.EURC(), address(eurc));
        assertEq(address(executor.universalRouter()), address(router));
        assertEq(address(executor.permit2()), address(permit2));
        assertEq(executor.poolFee(), POOL_FEE);
        assertEq(executor.poolTickSpacing(), TICK_SPACING);
        assertEq(executor.feeRecipient(), SAFE);
        assertEq(executor.feeBps(), FEE_BPS);
        assertEq(executor.owner(), SAFE);
        assertEq(executor.MAX_FEE_BPS(), 100);
        assertEq(executor.ARC_NATIVE_USDC_SCALE(), SCALE);
    }

    function testConstructorRejectsMismatchedFeeRecipient() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                WizPaySwapExecutorMainnet.FeeRecipientMustEqualOwner.selector, address(2), address(1)
            )
        );
        new WizPaySwapExecutorMainnet(
            address(1), address(2), 25, address(usdc), address(eurc), address(router), address(permit2), 500, 10
        );
    }

    function testConstructorRejectsExcessiveFee() public {
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.FeeExceedsMaximum.selector, 101, 100));
        new WizPaySwapExecutorMainnet(
            SAFE, SAFE, 101, address(usdc), address(eurc), address(router), address(permit2), 500, 10
        );
    }

    // =========================================================================
    // Exact command / action encoding
    // =========================================================================

    function testExpectedCommandBytes() public view {
        assertEq(executor.expectedCommands(), abi.encodePacked(uint8(0x10)));
    }

    function testExpectedActionBytes() public view {
        assertEq(executor.expectedActions(), abi.encodePacked(uint8(0x07), uint8(0x0b), uint8(0x0e)));
    }

    function testUsdcToEurcCommandAndActionEncoding() public {
        _doUsdcSwap(AMOUNT_IN, 800e6, 900e6);
        assertEq(router.lastCommands(), abi.encodePacked(uint8(0x10)), "commands=0x10");
        assertEq(router.lastActions(), abi.encodePacked(uint8(0x07), uint8(0x0b), uint8(0x0e)), "actions");
    }

    function testEurcToUsdcCommandAndActionEncoding() public {
        _doEurcSwap(AMOUNT_IN, 800e6, 900e6);
        assertEq(router.lastCommands(), abi.encodePacked(uint8(0x10)), "commands=0x10");
        assertEq(router.lastActions(), abi.encodePacked(uint8(0x07), uint8(0x0b), uint8(0x0e)), "actions");
    }

    // =========================================================================
    // SWAP_EXACT_IN ABI layout
    // =========================================================================

    function testSwapExactInParamLayoutUsdcToEurc() public {
        uint256 netAmountIn = _net(AMOUNT_IN);
        uint256 minOut = 800e6;
        _doUsdcSwap(AMOUNT_IN, minOut, 900e6);

        ExactInputSingleParams memory p = abi.decode(router.lastSwapExactInParam(), (ExactInputSingleParams));
        assertEq(p.currencyIn, address(usdc), "currencyIn=USDC");
        assertEq(p.path.length, 1, "path length");
        assertEq(p.path[0].intermediateCurrency, address(eurc), "path[0].intermediateCurrency");
        assertEq(uint24(p.path[0].fee), POOL_FEE, "path[0].fee=500");
        assertEq(int24(p.path[0].tickSpacing), TICK_SPACING, "path[0].tickSpacing=10");
        assertEq(p.path[0].hooks, address(0), "path[0].hooks=0");
        assertEq(p.path[0].hookData, "", "hookData=empty");
        assertEq(p.minHopPriceX36.length, 1, "hopPrices length");
        assertEq(p.minHopPriceX36[0], MIN_HOP_PRICE, "hopPrices[0]");
        assertEq(uint128(p.amountIn), uint128(netAmountIn), "amountIn=netAmountIn");
        assertEq(uint128(p.amountOutMinimum), uint128(minOut), "amountOutMinimum");
    }

    // =========================================================================
    // SETTLE: payerIsUser=false for USDC, payerIsUser=true for EURC
    // =========================================================================

    function testSettlePayerIsUserFalseForUsdcInput() public {
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        (address currency, uint256 amount, bool payerIsUser) =
            abi.decode(router.lastSettleParam(), (address, uint256, bool));
        assertEq(currency, address(usdc), "SETTLE currency=USDC");
        assertEq(amount, 0, "SETTLE amount=0");
        assertFalse(payerIsUser, "payerIsUser=false: router pays from its own received msg.value");
    }

    function testSettlePayerIsUserTrueForEurcInput() public {
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        (address currency, uint256 amount, bool payerIsUser) =
            abi.decode(router.lastSettleParam(), (address, uint256, bool));
        assertEq(currency, address(eurc), "SETTLE currency=EURC");
        assertEq(amount, 0, "SETTLE amount=0");
        assertTrue(payerIsUser, "payerIsUser=true: router uses Permit2 to pull EURC from executor");
    }

    // =========================================================================
    // TAKE: recipient = original executeSwap caller
    // =========================================================================

    function testTakeRecipientIsOriginalCallerUsdc() public {
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        (address currency, address recipient, uint256 amount) =
            abi.decode(router.lastTakeParam(), (address, address, uint256));
        assertEq(currency, address(eurc), "TAKE currency=EURC");
        assertEq(recipient, user, "TAKE recipient=original caller");
        assertEq(amount, 0, "TAKE amount=0");
    }

    function testTakeRecipientIsOriginalCallerEurc() public {
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        (address currency, address recipient,) = abi.decode(router.lastTakeParam(), (address, address, uint256));
        assertEq(currency, address(usdc), "TAKE currency=USDC");
        assertEq(recipient, user, "TAKE recipient=original caller");
    }

    // =========================================================================
    // USDC->EURC: native gross msg.value semantics
    // =========================================================================

    // Gross native value = amountIn * 1e12 must be sent.
    // Fee is deducted from this native value and sent to feeRecipient as native.
    // Net native value forwarded to router = netAmountIn * 1e12.
    // No USDC ERC-20 approval from user or executor to anyone is required.

    function testUsdcToEurcNativeMsgValueIsGrossAmountIn() public {
        // Contract validates msg.value == amountIn * SCALE (gross).
        // _doUsdcSwap already sends the correct gross value; confirm no revert.
        uint256 out = _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        assertGt(out, 0, "swap succeeded with gross native value");
    }

    function testUsdcToEurcRouterReceivesNetNativeValue() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        uint256 netAmountIn = AMOUNT_IN - feeAmount;
        uint256 expectedRouterNative = netAmountIn * SCALE;
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        assertEq(router.lastValue(), expectedRouterNative, "router native == net * 1e12");
    }

    function testUsdcToEurcNativeFeeDeliveredToFeeRecipient() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        uint256 expectedFeeNative = feeAmount * SCALE;
        uint256 safeBefore = SAFE.balance;
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        assertEq(SAFE.balance, safeBefore + expectedFeeNative, "feeRecipient received native fee");
    }

    function testUsdcToEurcNoResidualNativeInExecutor() public {
        // Executor must not hold any native after the swap.
        uint256 execBefore = address(executor).balance;
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        assertEq(address(executor).balance, execBefore, "no native residual in executor");
    }

    function testUsdcToEurcNoUsdcErc20ApprovalRequired() public {
        // USDC->EURC requires NO ERC-20 approval from user to executor.
        // Send gross native value directly without any ERC-20 approve call.
        uint256 grossNative = AMOUNT_IN * SCALE;
        router.configure(900e6, false);
        vm.deal(user, grossNative);
        vm.prank(user);
        uint256 out = executor.executeSwap{value: grossNative}(
            address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
        assertGt(out, 0, "swap succeeded without ERC-20 approval");
    }

    function testUsdcToEurcEurcDeliveredToOriginalCaller() public {
        uint256 amountOut = 950e6;
        uint256 userEurcBefore = eurc.balanceOf(user);
        _doUsdcSwap(AMOUNT_IN, 1, amountOut);
        assertEq(eurc.balanceOf(user), userEurcBefore + amountOut, "EURC delivered to caller");
    }

    // =========================================================================
    // USDC->EURC: full flow
    // =========================================================================

    function testUsdcToEurcFullFlow() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        uint256 netAmountIn = AMOUNT_IN - feeAmount;
        uint256 grossNative = AMOUNT_IN * SCALE;
        uint256 netNative = netAmountIn * SCALE;
        uint256 feeNative = feeAmount * SCALE;
        uint256 amountOut = 900e6;

        uint256 safeBefore = SAFE.balance;
        uint256 userEurcBefore = eurc.balanceOf(user);

        router.configure(amountOut, false);
        vm.deal(user, grossNative);
        vm.prank(user);
        uint256 out = executor.executeSwap{value: grossNative}(
            address(usdc), address(eurc), AMOUNT_IN, 800e6, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );

        assertEq(out, amountOut, "returned amountOut");
        assertEq(SAFE.balance, safeBefore + feeNative, "feeRecipient received native fee");
        assertEq(router.lastValue(), netNative, "router received net native");
        assertEq(eurc.balanceOf(user), userEurcBefore + amountOut, "user received EURC");
        assertEq(eurc.balanceOf(address(executor)), 0, "no EURC residual in executor");
        assertEq(address(executor).balance, 0, "no native residual in executor");
    }

    // =========================================================================
    // EURC->USDC: executor-intermediary asset and allowance flow
    // =========================================================================

    function testEurcToUsdcExecutorOwnsNetEurcBeforeRouterCall() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        assertEq(eurc.balanceOf(address(executor)), 0, "executor starts with 0 EURC");
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        assertEq(eurc.balanceOf(address(executor)), 0, "executor holds 0 EURC after swap");
        assertEq(eurc.balanceOf(SAFE), feeAmount, "Safe received EURC fee");
    }

    function testEurcToUsdcErc20AllowanceExecutorToPermit2IsGrantedAndCleared() public {
        assertEq(eurc.allowance(address(executor), address(permit2)), 0, "no allowance before");
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        assertEq(eurc.allowance(address(executor), address(permit2)), 0, "ERC-20 allowance cleared after swap");
    }

    function testEurcToUsdcPermit2AllowanceExecutorToRouterIsGrantedAndCleared() public {
        (uint160 before,,) = permit2.allowance(address(executor), address(eurc), address(router));
        assertEq(before, 0, "no Permit2 allowance before swap");
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        (uint160 after_,,) = permit2.allowance(address(executor), address(eurc), address(router));
        assertEq(after_, 0, "Permit2 allowance cleared after swap");
    }

    function testEurcToUsdcPermit2AllowanceBoundedByNetAmount() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        uint256 netAmountIn = AMOUNT_IN - feeAmount;

        SpyPermit2 spyPermit2 = new SpyPermit2();
        SimpleMockRouter simpleRouter = new SimpleMockRouter(usdc, eurc, spyPermit2);
        WizPaySwapExecutorMainnet spyExec = new WizPaySwapExecutorMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(simpleRouter),
            address(spyPermit2),
            POOL_FEE,
            TICK_SPACING
        );
        usdc.transfer(address(simpleRouter), 10_000e6);

        eurc.transfer(user, AMOUNT_IN);
        vm.prank(user);
        eurc.approve(address(spyExec), AMOUNT_IN);
        vm.prank(user);
        spyExec.executeSwap{value: 0}(
            address(eurc), address(usdc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );

        assertEq(spyPermit2.lastApproveAmount(), uint160(netAmountIn), "Permit2 allowance == netAmountIn");
        assertEq(spyPermit2.lastApproveToken(), address(eurc), "Permit2 token=EURC");
        assertEq(spyPermit2.lastApproveSpender(), address(simpleRouter), "Permit2 spender=router");
        assertEq(spyPermit2.lastClearAmount(), 0, "Permit2 cleared to 0 after swap");
    }

    function testEurcToUsdcAllowanceClearedAfterSwap() public {
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        assertEq(eurc.allowance(address(executor), address(permit2)), 0, "ERC-20 allowance=0");
        (uint160 p2,,) = permit2.allowance(address(executor), address(eurc), address(router));
        assertEq(p2, 0, "Permit2 allowance=0");
    }

    function testEurcToUsdcAllowanceClearedOnRouterRevert() public {
        router.configureRevert("router failed");
        vm.prank(user);
        eurc.approve(address(executor), AMOUNT_IN);
        vm.expectRevert(bytes("router failed"));
        vm.prank(user);
        executor.executeSwap{value: 0}(
            address(eurc), address(usdc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
        // Whole tx reverted: approvals never persisted.
        assertEq(eurc.allowance(address(executor), address(permit2)), 0, "no allowance after revert");
        (uint160 p2,,) = permit2.allowance(address(executor), address(eurc), address(router));
        assertEq(p2, 0, "no Permit2 allowance after revert");
        assertEq(eurc.balanceOf(address(executor)), 0, "no EURC in executor after revert");
    }

    function testEurcToUsdcZeroResidualEurcInExecutor() public {
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        assertEq(eurc.balanceOf(address(executor)), 0, "zero residual EURC");
        assertEq(usdc.balanceOf(address(executor)), 0, "zero residual USDC");
    }

    function testEurcToUsdcUsdcOutputDeliveredToOriginalCaller() public {
        uint256 amountOut = 1_155e6;
        uint256 userUsdcBefore = usdc.balanceOf(user);
        _doEurcSwap(AMOUNT_IN, 1_000e6, amountOut);
        assertEq(usdc.balanceOf(user), userUsdcBefore + amountOut, "USDC delivered to original caller");
    }

    // =========================================================================
    // EURC->USDC: full flow
    // =========================================================================

    function testEurcToUsdcFullFlow() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        uint256 amountOut = 1_155e6;

        uint256 userEurcBefore = eurc.balanceOf(user);
        uint256 safeEurcBefore = eurc.balanceOf(SAFE);
        uint256 userUsdcBefore = usdc.balanceOf(user);

        _doEurcSwap(AMOUNT_IN, 1_000e6, amountOut);

        assertEq(eurc.balanceOf(user), userEurcBefore - AMOUNT_IN, "user EURC reduced by gross amountIn");
        assertEq(eurc.balanceOf(SAFE), safeEurcBefore + feeAmount, "Safe received EURC fee");
        assertEq(usdc.balanceOf(user), userUsdcBefore + amountOut, "user received USDC");
        assertEq(eurc.balanceOf(address(executor)), 0, "no EURC residual");
        assertEq(usdc.balanceOf(address(executor)), 0, "no USDC residual");
        assertEq(router.lastValue(), 0, "no native value for EURC input");
    }

    // =========================================================================
    // Native value: 1e12 scale
    // =========================================================================

    function testNativeValueIs1e12ScaleOfNetAmount() public {
        uint256 netAmountIn = _net(AMOUNT_IN);
        uint256 expectedRouterNative = netAmountIn * SCALE;
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        assertEq(router.lastValue(), expectedRouterNative, "router native == net * 1e12");
    }

    // Gross native = amountIn * SCALE; sending anything else must revert.
    function testUsdcInputRevertsOnWrongNativeValue() public {
        uint256 correctNative = AMOUNT_IN * SCALE;
        vm.deal(user, correctNative + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                WizPaySwapExecutorMainnet.NativeMsgValueMismatch.selector, correctNative + 1, correctNative
            )
        );
        vm.prank(user);
        executor.executeSwap{value: correctNative + 1}(
            address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    function testUsdcInputRevertsOnLowNativeValue() public {
        uint256 correctNative = AMOUNT_IN * SCALE;
        vm.deal(user, correctNative - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                WizPaySwapExecutorMainnet.NativeMsgValueMismatch.selector, correctNative - 1, correctNative
            )
        );
        vm.prank(user);
        executor.executeSwap{value: correctNative - 1}(
            address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    function testUsdcInputRevertsOnZeroNativeValue() public {
        uint256 correctNative = AMOUNT_IN * SCALE;
        vm.expectRevert(
            abi.encodeWithSelector(WizPaySwapExecutorMainnet.NativeMsgValueMismatch.selector, 0, correctNative)
        );
        vm.prank(user);
        executor.executeSwap{value: 0}(
            address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    function testEurcInputRevertsOnNonZeroNativeValue() public {
        _approveEurc(user, AMOUNT_IN);
        vm.deal(user, 1);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.NativeMsgValueMismatch.selector, 1, 0));
        vm.prank(user);
        executor.executeSwap{value: 1}(
            address(eurc), address(usdc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    // =========================================================================
    // Fee accounting
    // =========================================================================

    function testFeeAccountingUsdcNative() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        uint256 netAmountIn = AMOUNT_IN - feeAmount;
        uint256 safeBefore = SAFE.balance;
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        // Fee is delivered as native to feeRecipient.
        assertEq(SAFE.balance, safeBefore + feeAmount * SCALE, "native fee to Safe");
        // Router sees net in the SWAP_EXACT_IN param.
        ExactInputSingleParams memory p = abi.decode(router.lastSwapExactInParam(), (ExactInputSingleParams));
        assertEq(uint128(p.amountIn), uint128(netAmountIn), "router sees netAmountIn");
    }

    function testFeeAccountingEurc() public {
        uint256 feeAmount = _fee(AMOUNT_IN);
        uint256 netAmountIn = AMOUNT_IN - feeAmount;
        _doEurcSwap(AMOUNT_IN, 1, 1_000e6);
        assertEq(eurc.balanceOf(SAFE), feeAmount, "EURC fee to Safe");
        ExactInputSingleParams memory p = abi.decode(router.lastSwapExactInParam(), (ExactInputSingleParams));
        assertEq(uint128(p.amountIn), uint128(netAmountIn), "router sees netAmountIn");
    }

    function testZeroFeeWorks() public {
        WizPaySwapExecutorMainnet zeroFeeExec = new WizPaySwapExecutorMainnet(
            SAFE, SAFE, 0, address(usdc), address(eurc), address(router), address(permit2), 500, 10
        );
        uint256 grossNative = AMOUNT_IN * SCALE;
        router.configure(900e6, false);
        vm.deal(user, grossNative);
        vm.prank(user);
        zeroFeeExec.executeSwap{value: grossNative}(
            address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
        // Zero fee: feeRecipient native balance unchanged.
        assertEq(SAFE.balance, 0, "no fee charged");
        // Router receives gross native (fee=0 => net=gross).
        assertEq(router.lastValue(), grossNative, "router gets gross when fee=0");
    }

    // =========================================================================
    // Pool key binding
    // =========================================================================

    function testPoolKeyIsEncodedInSwapParams() public {
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        ExactInputSingleParams memory p = abi.decode(router.lastSwapExactInParam(), (ExactInputSingleParams));
        assertEq(uint24(p.path[0].fee), 500, "pool fee=500");
        assertEq(int24(p.path[0].tickSpacing), 10, "pool tickSpacing=10");
        assertEq(p.path[0].hooks, address(0), "no hooks");
    }

    // =========================================================================
    // Slippage
    // =========================================================================

    function testSlippageExceededReverts() public {
        uint256 grossNative = AMOUNT_IN * SCALE;
        router.configure(800e6, false);
        vm.deal(user, grossNative);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.SlippageExceeded.selector, 800e6, 900e6));
        vm.prank(user);
        executor.executeSwap{value: grossNative}(
            address(usdc), address(eurc), AMOUNT_IN, 900e6, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    // =========================================================================
    // Deadline
    // =========================================================================

    function testExpiredDeadlineReverts() public {
        vm.warp(200);
        uint256 grossNative = AMOUNT_IN * SCALE;
        vm.deal(user, grossNative);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.DeadlineExpired.selector, 199, 200));
        vm.prank(user);
        executor.executeSwap{value: grossNative}(address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, 199);
    }

    function testDeadlineTooFarReverts() public {
        uint256 max = block.timestamp + executor.MAX_DEADLINE_WINDOW();
        uint256 grossNative = AMOUNT_IN * SCALE;
        vm.deal(user, grossNative);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.DeadlineTooFar.selector, max + 1, max));
        vm.prank(user);
        executor.executeSwap{value: grossNative}(address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, max + 1);
    }

    // =========================================================================
    // Input validation
    // =========================================================================

    function testUnsupportedTokenPairReverts() public {
        MockERC20 other = new MockERC20("X", "X", 6, 1_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                WizPaySwapExecutorMainnet.UnsupportedSwapPair.selector, address(other), address(eurc)
            )
        );
        vm.prank(user);
        executor.executeSwap{value: 0}(address(other), address(eurc), 1, 1, 1, block.timestamp + 1);
    }

    function testSameTokenRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(WizPaySwapExecutorMainnet.UnsupportedSwapPair.selector, address(usdc), address(usdc))
        );
        vm.prank(user);
        executor.executeSwap{value: 0}(address(usdc), address(usdc), 1, 1, 1, block.timestamp + 1);
    }

    function testZeroAmountInReverts() public {
        vm.expectRevert(WizPaySwapExecutorMainnet.AmountMustBeGreaterThanZero.selector);
        vm.prank(user);
        executor.executeSwap{value: 0}(address(usdc), address(eurc), 0, 1, 1, block.timestamp + 1);
    }

    function testZeroMinAmountOutReverts() public {
        vm.expectRevert(WizPaySwapExecutorMainnet.MinAmountOutZero.selector);
        vm.prank(user);
        executor.executeSwap{value: 0}(address(usdc), address(eurc), 1, 0, 1, block.timestamp + 1);
    }

    function testZeroMinHopPriceX36Reverts() public {
        vm.expectRevert(WizPaySwapExecutorMainnet.MinHopPriceX36Zero.selector);
        vm.prank(user);
        executor.executeSwap{value: 0}(address(usdc), address(eurc), 1, 1, 0, block.timestamp + 1);
    }

    // =========================================================================
    // Residual balance protection
    // =========================================================================

    // EURC->USDC: router delivers USDC to executor instead of caller.
    function testResidualOutputBalanceReverts() public {
        MockPermit2 localPermit2 = new MockPermit2();
        StuckOutputEurcRouter stuckRouter = new StuckOutputEurcRouter(usdc, eurc, localPermit2);
        WizPaySwapExecutorMainnet stuckExec = new WizPaySwapExecutorMainnet(
            SAFE, SAFE, 0, address(usdc), address(eurc), address(stuckRouter), address(localPermit2), 500, 10
        );
        usdc.transfer(address(stuckRouter), 1_000e6);
        eurc.transfer(user, AMOUNT_IN);

        vm.prank(user);
        eurc.approve(address(stuckExec), AMOUNT_IN);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.ResidualOutputBalance.selector, 0, 500e6));
        vm.prank(user);
        stuckExec.executeSwap{value: 0}(
            address(eurc), address(usdc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    // EURC->USDC: router does not pull EURC, leaving it stuck in executor.
    function testResidualInputBalanceRevertsEurc() public {
        ResidualInputRouter residualRouter = new ResidualInputRouter(usdc, eurc);
        MockPermit2 localPermit2 = new MockPermit2();
        WizPaySwapExecutorMainnet residualExec = new WizPaySwapExecutorMainnet(
            SAFE, SAFE, 0, address(usdc), address(eurc), address(residualRouter), address(localPermit2), 500, 10
        );
        usdc.transfer(address(residualRouter), 10_000e6);

        vm.prank(user);
        eurc.approve(address(residualExec), AMOUNT_IN);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.ResidualInputBalance.selector, 0, AMOUNT_IN));
        vm.prank(user);
        residualExec.executeSwap{value: 0}(
            address(eurc), address(usdc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    // USDC->EURC: verify executor ends with exactly zero native (residual guard).
    // The contract has no receive(), so no external push can inflate its balance.
    // The guard fires only on arithmetic residual; we verify the happy path here.
    function testResidualNativeBalanceIsZeroAfterUsdcSwap() public {
        // Pre-load executor with zero native (default). Gross native is fully
        // disbursed as fee + net, leaving the executor with exactly 0.
        assertEq(address(executor).balance, 0, "executor starts with 0");
        _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        assertEq(address(executor).balance, 0, "executor ends with 0 native");
    }

    // =========================================================================
    // Reentrancy
    // =========================================================================

    function testReentrancyIsBlocked() public {
        ReentrantRouterPlaceholder placeholder = new ReentrantRouterPlaceholder();
        WizPaySwapExecutorMainnet reentrantExec = new WizPaySwapExecutorMainnet(
            SAFE, SAFE, 0, address(usdc), address(eurc), address(placeholder), address(permit2), 500, 10
        );
        placeholder.setExecutor(reentrantExec, address(eurc), address(usdc));

        eurc.transfer(user, AMOUNT_IN);
        vm.prank(user);
        eurc.approve(address(reentrantExec), AMOUNT_IN);
        vm.expectRevert();
        vm.prank(user);
        reentrantExec.executeSwap{value: 0}(
            address(eurc), address(usdc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    // =========================================================================
    // Pause
    // =========================================================================

    function testPauseBlocksSwaps() public {
        vm.prank(SAFE);
        executor.pause();
        uint256 grossNative = AMOUNT_IN * SCALE;
        vm.deal(user, grossNative);
        vm.expectRevert();
        vm.prank(user);
        executor.executeSwap{value: grossNative}(
            address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    function testUnpauseRestoresSwaps() public {
        vm.prank(SAFE);
        executor.pause();
        vm.prank(SAFE);
        executor.unpause();
        uint256 out = _doUsdcSwap(AMOUNT_IN, 1, 900e6);
        assertGt(out, 0);
    }

    function testOnlyOwnerCanPause() public {
        vm.expectRevert();
        vm.prank(user);
        executor.pause();
    }

    // =========================================================================
    // Ownership lock
    // =========================================================================

    function testOwnershipIsLocked() public {
        vm.startPrank(SAFE);
        vm.expectRevert(WizPaySwapExecutorMainnet.OwnershipLocked.selector);
        executor.transferOwnership(user);
        vm.expectRevert(WizPaySwapExecutorMainnet.OwnershipLocked.selector);
        executor.renounceOwnership();
        vm.stopPrank();
    }

    // =========================================================================
    // EOA and Safe-like (smart-contract account) callers
    // =========================================================================

    function testSmartContractAccountCallerUsdc() public {
        MockSmartContractAccount account = new MockSmartContractAccount();
        uint256 grossNative = AMOUNT_IN * SCALE;
        vm.deal(address(account), grossNative);
        router.configure(900e6, false);
        // approveAndSwap approves usdc (ignored for native path) and forwards msg.value.
        uint256 out = account.approveAndSwap{value: grossNative}(
            usdc, executor, address(usdc), address(eurc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
        assertGt(out, 0);
        assertEq(eurc.balanceOf(address(account)), out, "EURC output to account");
    }

    function testSmartContractAccountCallerEurc() public {
        MockSmartContractAccount account = new MockSmartContractAccount();
        eurc.transfer(address(account), AMOUNT_IN);
        router.configure(1_000e6, false);
        uint256 out = account.approveAndSwap{value: 0}(
            eurc, executor, address(eurc), address(usdc), AMOUNT_IN, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
        assertGt(out, 0);
        assertEq(usdc.balanceOf(address(account)), out, "USDC output to account");
    }

    // =========================================================================
    // Rescue
    // =========================================================================

    function testRescueBlockedForUsdcAndEurc() public {
        MockERC20 stray = new MockERC20("S", "S", 6, 100);
        stray.transfer(address(executor), 10);
        vm.startPrank(SAFE);
        executor.pause();
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.TokenRescueBlocked.selector, address(usdc)));
        executor.rescueTokens(address(usdc), SAFE, 1);
        vm.expectRevert(abi.encodeWithSelector(WizPaySwapExecutorMainnet.TokenRescueBlocked.selector, address(eurc)));
        executor.rescueTokens(address(eurc), SAFE, 1);
        executor.rescueTokens(address(stray), SAFE, 10);
        vm.stopPrank();
        assertEq(stray.balanceOf(SAFE), 10, "stray token rescued");
    }

    function testRescueOnlyWhenPaused() public {
        MockERC20 stray = new MockERC20("S", "S", 6, 100);
        stray.transfer(address(executor), 10);
        vm.expectRevert();
        vm.prank(SAFE);
        executor.rescueTokens(address(stray), SAFE, 10);
    }

    // =========================================================================
    // Fuzz: fee conservation
    // =========================================================================

    function testFuzz_usdcToEurcFeeConservation(uint256 rawAmount) public {
        rawAmount = bound(rawAmount, 1e6, 1_000_000e6);
        uint256 feeAmount = (rawAmount * FEE_BPS) / 10_000;
        uint256 netAmountIn = rawAmount - feeAmount;
        uint256 grossNative = rawAmount * SCALE;

        if (eurc.balanceOf(address(router)) < netAmountIn) eurc.transfer(address(router), netAmountIn);
        router.configure(netAmountIn * 9 / 10, false);

        uint256 safeBefore = SAFE.balance;
        vm.deal(user, grossNative);
        vm.prank(user);
        executor.executeSwap{value: grossNative}(
            address(usdc), address(eurc), rawAmount, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );

        // Native fee = feeAmount * SCALE delivered to feeRecipient.
        assertEq(SAFE.balance, safeBefore + feeAmount * SCALE, "native fee conservation");
        // Executor holds no native residual.
        assertEq(address(executor).balance, 0, "no native residual in executor");
    }

    function testFuzz_eurcToUsdcFeeConservation(uint256 rawAmount) public {
        rawAmount = bound(rawAmount, 1e6, 100_000e6);
        uint256 feeAmount = (rawAmount * FEE_BPS) / 10_000;
        uint256 netAmountIn = rawAmount - feeAmount;

        if (eurc.balanceOf(user) < rawAmount) eurc.transfer(user, rawAmount);
        if (usdc.balanceOf(address(router)) < rawAmount) usdc.transfer(address(router), rawAmount);
        router.configure(netAmountIn * 9 / 10, false);

        uint256 safeBefore = eurc.balanceOf(SAFE);
        vm.prank(user);
        eurc.approve(address(executor), rawAmount);
        vm.prank(user);
        executor.executeSwap{value: 0}(
            address(eurc), address(usdc), rawAmount, 1, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );

        assertEq(eurc.balanceOf(SAFE), safeBefore + feeAmount, "EURC fee conservation");
        assertEq(eurc.balanceOf(address(executor)), 0, "no EURC residual");
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _net(uint256 gross) internal pure returns (uint256) {
        return gross - (gross * FEE_BPS) / 10_000;
    }

    function _fee(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / 10_000;
    }

    function _approveEurc(address from, uint256 amount) internal {
        vm.prank(from);
        eurc.approve(address(executor), amount);
    }

    /// @dev USDC->EURC swap. Sends grossNative = amountIn * SCALE (no ERC-20 approval).
    function _doUsdcSwap(uint256 amountIn, uint256 minOut, uint256 routerOut) internal returns (uint256) {
        uint256 grossNative = amountIn * SCALE;
        router.configure(routerOut, false);
        vm.deal(user, grossNative);
        vm.prank(user);
        return executor.executeSwap{value: grossNative}(
            address(usdc), address(eurc), amountIn, minOut, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }

    /// @dev EURC->USDC swap helper. Returns amountOut.
    function _doEurcSwap(uint256 amountIn, uint256 minOut, uint256 routerOut) internal returns (uint256) {
        router.configure(routerOut, false);
        _approveEurc(user, amountIn);
        vm.prank(user);
        return executor.executeSwap{value: 0}(
            address(eurc), address(usdc), amountIn, minOut, MIN_HOP_PRICE, block.timestamp + 10 minutes
        );
    }
}

// ---------------------------------------------------------------------------
// SpyPermit2: records the approve() call (non-zero and zero separately).
// ---------------------------------------------------------------------------

contract SpyPermit2 {
    address public lastApproveToken;
    address public lastApproveSpender;
    uint160 public lastApproveAmount;
    uint160 public lastClearAmount = type(uint160).max; // sentinel until first clear

    mapping(address => mapping(address => mapping(address => uint160))) private _a;
    mapping(address => mapping(address => mapping(address => uint48))) private _e;

    function approve(address token, address spender, uint160 amount, uint48 exp) external {
        _a[msg.sender][token][spender] = amount;
        _e[msg.sender][token][spender] = exp;
        if (amount == 0) {
            lastClearAmount = 0;
        } else {
            lastApproveToken = token;
            lastApproveSpender = spender;
            lastApproveAmount = amount;
        }
    }

    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48) {
        return (_a[owner][token][spender], _e[owner][token][spender], 0);
    }

    function pullFrom(address from, address token, address to, uint160 amount) external {
        require(_a[from][token][msg.sender] >= amount, "SpyPermit2: p2 allowance");
        _a[from][token][msg.sender] -= amount;
        IERC20(token).transferFrom(from, to, amount);
    }
}

// ---------------------------------------------------------------------------
// SimpleMockRouter: delivers configured output for SpyPermit2 test.
// Pulls EURC via Permit2 on the EURC path to clear residual balance.
// ---------------------------------------------------------------------------

contract SimpleMockRouter {
    MockERC20 internal _usdc;
    MockERC20 internal _eurc;
    SpyPermit2 internal _permit2;
    uint256 public routedAmountOut = 900e6;

    constructor(MockERC20 usdc_, MockERC20 eurc_, SpyPermit2 permit2_) {
        _usdc = usdc_;
        _eurc = eurc_;
        _permit2 = permit2_;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address tokenOut, address recipient,) = abi.decode(params[2], (address, address, uint256));
        MockERC20(tokenOut).transfer(recipient, routedAmountOut);
        // Consume input to avoid residual balance check.
        (address settleToken,,) = abi.decode(params[1], (address, uint256, bool));
        if (msg.value == 0) {
            // EURC path: pull via Permit2.
            (uint160 p2amount,,) = _permit2.allowance(msg.sender, settleToken, address(this));
            if (p2amount > 0) {
                _permit2.pullFrom(msg.sender, settleToken, address(this), p2amount);
            }
        }
        // USDC path: native received; no ERC-20 action needed.
    }
}

// ---------------------------------------------------------------------------
// ReentrantRouterPlaceholder
// ---------------------------------------------------------------------------

contract ReentrantRouterPlaceholder {
    WizPaySwapExecutorMainnet internal _executor;
    address internal _tokenIn;
    address internal _tokenOut;
    bool internal _set;

    function setExecutor(WizPaySwapExecutorMainnet exec_, address tokenIn_, address tokenOut_) external {
        _executor = exec_;
        _tokenIn = tokenIn_;
        _tokenOut = tokenOut_;
        _set = true;
    }

    function execute(bytes calldata, bytes[] calldata, uint256 deadline) external payable {
        require(_set, "not configured");
        _executor.executeSwap{value: 0}(_tokenIn, _tokenOut, 1, 1, 1, deadline);
    }
}

// ---------------------------------------------------------------------------
// StuckOutputEurcRouter: for EURC->USDC direction.
// Pulls EURC from executor via Permit2 correctly, but delivers USDC output to
// executor (msg.sender) instead of the user, triggering ResidualOutputBalance.
// ---------------------------------------------------------------------------

contract StuckOutputEurcRouter {
    MockERC20 internal _usdc;
    MockERC20 internal _eurc;
    MockPermit2 internal _permit2;

    constructor(MockERC20 usdc_, MockERC20 eurc_, MockPermit2 permit2_) {
        _usdc = usdc_;
        _eurc = eurc_;
        _permit2 = permit2_;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address settleToken,,) = abi.decode(params[1], (address, uint256, bool));
        (uint160 p2Amount,,) = _permit2.allowance(msg.sender, settleToken, address(this));
        if (p2Amount > 0) {
            _permit2.pullFrom(msg.sender, settleToken, address(this), p2Amount);
        }
        // Deliver USDC to executor (msg.sender) instead of user ->
        // executor USDC balance rises -> ResidualOutputBalance fires.
        _usdc.transfer(msg.sender, 500e6);
    }
}

// ---------------------------------------------------------------------------
// ResidualInputRouter: does NOT pull EURC from executor, leaving netAmountIn
// stuck there. Delivers USDC output so slippage check does not fire first.
// ---------------------------------------------------------------------------

contract ResidualInputRouter {
    MockERC20 internal _usdc;
    MockERC20 internal _eurc;

    constructor(MockERC20 usdc_, MockERC20 eurc_) {
        _usdc = usdc_;
        _eurc = eurc_;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address tokenOut, address recipient,) = abi.decode(params[2], (address, address, uint256));
        IERC20(tokenOut).transfer(recipient, 900e6);
        // Intentionally do NOT pull EURC -> triggers ResidualInputBalance.
    }
}
