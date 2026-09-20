// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";
import {WizPayPayrollMainnet} from "src/WizPayPayrollMainnet.sol";

// ---------------------------------------------------------------------------
// MockPermit2
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
// MockPoolManager: code-bearing stub so the router<->PoolManager binding
// can be tested without a real PoolManager deployment.
// ---------------------------------------------------------------------------

contract MockPoolManager {}

// ---------------------------------------------------------------------------
// MockPayrollRouter: TAKE recipient is the payroll contract.
// USDC path (msg.value > 0): assert payerIsUser=false, accept native,
//   deliver configured output to TAKE recipient.
// EURC path (msg.value == 0): assert payerIsUser=true, pull via Permit2,
//   deliver configured output to TAKE recipient.
// ---------------------------------------------------------------------------

contract MockPayrollRouter {
    bytes public lastCommands;
    bytes public lastActions;
    bytes public lastSwapExactInParam;
    bytes public lastSettleParam;
    bytes public lastTakeParam;
    uint256 public lastValue;
    uint256 public lastDeadline;
    uint256 public callCount;

    uint256 public routedAmountOut;
    bool public shouldRevert;
    string public revertReason;

    MockERC20 internal _usdc;
    MockERC20 internal _eurc;
    MockPermit2 internal _permit2;
    address internal _poolManager;

    constructor(MockERC20 usdc_, MockERC20 eurc_, MockPermit2 permit2_, address poolManager_) {
        _usdc = usdc_;
        _eurc = eurc_;
        _permit2 = permit2_;
        _poolManager = poolManager_;
    }

    function poolManager() external view returns (address) {
        return _poolManager;
    }

    function configure(uint256 amountOut_) external {
        routedAmountOut = amountOut_;
        shouldRevert = false;
    }

    function configureRevert(string calldata reason) external {
        shouldRevert = true;
        revertReason = reason;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        if (shouldRevert) revert(revertReason);
        callCount++;
        lastCommands = commands;
        lastDeadline = deadline;
        lastValue = msg.value;
        require(inputs.length == 1, "expected 1 input");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        lastActions = actions;
        require(params.length == 3, "expected 3 params");
        lastSwapExactInParam = params[0];
        lastSettleParam = params[1];
        lastTakeParam = params[2];

        (,, bool payerIsUser) = abi.decode(lastSettleParam, (address, uint256, bool));
        (address tokenOut, address recipient,) = abi.decode(lastTakeParam, (address, address, uint256));
        (address settleToken,,) = abi.decode(lastSettleParam, (address, uint256, bool));

        if (msg.value > 0) {
            require(!payerIsUser, "MockRouter: USDC SETTLE must be payerIsUser=false");
            (settleToken);
        } else {
            require(payerIsUser, "MockRouter: EURC SETTLE must be payerIsUser=true");
            (uint160 p2Amount,,) = _permit2.allowance(msg.sender, settleToken, address(this));
            require(p2Amount > 0, "MockRouter: no Permit2 allowance");
            _permit2.pullFrom(msg.sender, settleToken, address(this), p2Amount);
        }

        if (routedAmountOut > 0) {
            MockERC20(tokenOut).transfer(recipient, routedAmountOut);
        }
    }
}

// ---------------------------------------------------------------------------
// BypassRouter: pulls input correctly but delivers output directly to an
// outsider, bypassing the payroll TAKE recipient. Proves atomic revert:
// payroll sees zero output and reverts, rolling back the bypass delivery.
// ---------------------------------------------------------------------------

contract BypassRouter {
    MockERC20 internal _usdc;
    MockPermit2 internal _permit2;
    address internal _outsider;
    address internal _poolManager;

    constructor(MockERC20 usdc_, MockPermit2 permit2_, address outsider_, address poolManager_) {
        _usdc = usdc_;
        _permit2 = permit2_;
        _outsider = outsider_;
        _poolManager = poolManager_;
    }

    function poolManager() external view returns (address) {
        return _poolManager;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address settleToken,, bool payerIsUser) = abi.decode(params[1], (address, uint256, bool));
        if (msg.value == 0 && payerIsUser) {
            (uint160 p2Amount,,) = _permit2.allowance(msg.sender, settleToken, address(this));
            if (p2Amount > 0) _permit2.pullFrom(msg.sender, settleToken, address(this), p2Amount);
        }
        _usdc.transfer(_outsider, 500e6);
    }
}

// ---------------------------------------------------------------------------
// ResidualInputRouter: never pulls EURC, delivers output anyway.
// ---------------------------------------------------------------------------

contract ResidualInputRouter {
    MockERC20 internal _usdc;
    address internal _poolManager;

    constructor(MockERC20 usdc_, address poolManager_) {
        _usdc = usdc_;
        _poolManager = poolManager_;
    }

    function poolManager() external view returns (address) {
        return _poolManager;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address tokenOut, address recipient,) = abi.decode(params[2], (address, address, uint256));
        IERC20(tokenOut).transfer(recipient, 900e6);
    }
}

// ---------------------------------------------------------------------------
// ReentrantPayrollRouter: adversarial reentrancy probe.
// During the outer cross-token swap it attempts a nested same-token payroll
// that is FULLY VALID on its own (funded balance, approval, valid recipient,
// fresh reference, zero-fee target): it would succeed if the ReentrancyGuard
// were removed. The nested revert data is recorded so the test can prove the
// failure is specifically the guard, then normal swap behavior continues so
// the outer payroll still succeeds.
// ---------------------------------------------------------------------------

contract ReentrantPayrollRouter {
    MockERC20 internal _usdc;
    MockERC20 internal _eurc;
    MockPermit2 internal _permit2;
    address internal _poolManager;
    WizPayPayrollMainnet internal _payroll;
    MockERC20 internal _nestedToken;

    bytes public nestedRevertData;
    bool public nestedSucceeded;
    bool public nestedAttempted;

    constructor(MockERC20 usdc_, MockERC20 eurc_, MockPermit2 permit2_, address poolManager_, MockERC20 nestedToken_) {
        _usdc = usdc_;
        _eurc = eurc_;
        _permit2 = permit2_;
        _poolManager = poolManager_;
        _nestedToken = nestedToken_;
    }

    function poolManager() external view returns (address) {
        return _poolManager;
    }

    function setPayroll(WizPayPayrollMainnet p) external {
        _payroll = p;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        // Adversarial nested call: router holds a funded balance and has
        // approved the payroll, recipient is valid, reference is fresh.
        address[] memory recipients = new address[](1);
        recipients[0] = address(0xBEEF);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100;
        nestedAttempted = true;
        try _payroll.executeSameTokenPayroll(address(_nestedToken), recipients, amounts, "REENTER-GUARD") {
            nestedSucceeded = true;
        } catch (bytes memory reason) {
            nestedRevertData = reason;
        }

        // Normal swap behavior so the outer payroll can still succeed.
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address settleToken,, bool payerIsUser) = abi.decode(params[1], (address, uint256, bool));
        (address tokenOut, address recipient,) = abi.decode(params[2], (address, address, uint256));
        if (msg.value == 0 && payerIsUser) {
            (uint160 p2Amount,,) = _permit2.allowance(msg.sender, settleToken, address(this));
            require(p2Amount > 0, "ReentrantRouter: no Permit2 allowance");
            _permit2.pullFrom(msg.sender, settleToken, address(this), p2Amount);
        }
        MockERC20(tokenOut).transfer(recipient, 900e6);
    }
}

// ---------------------------------------------------------------------------
// Hostile tokens
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ReentrantPayrollToken: adversarial reentrancy probe at the token layer.
// The nested same-token payroll is FULLY VALID on its own (this contract
// holds a funded balance and has approved the payroll, recipient is valid,
// reference is fresh, zero-fee target): it would succeed if the
// ReentrancyGuard were removed. Revert data is recorded so the test proves
// the failure is specifically the guard; the outer transfer then proceeds
// so the outer payroll still succeeds.
// ---------------------------------------------------------------------------

contract ReentrantPayrollToken is FalseReturnToken {
    WizPayPayrollMainnet public target;
    bytes public nestedRevertData;
    bool public nestedSucceeded;
    bool public nestedAttempted;
    bool private attacking;

    function setTarget(WizPayPayrollMainnet t) external {
        target = t;
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
            nestedAttempted = true;
            address[] memory recipients = new address[](1);
            recipients[0] = address(0xBEEF);
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = 100;
            try target.executeSameTokenPayroll(address(this), recipients, amounts, "REENTER-GUARD") {
                nestedSucceeded = true;
            } catch (bytes memory reason) {
                nestedRevertData = reason;
            }
            attacking = false;
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// ---------------------------------------------------------------------------
// Mirror types for ABI decode
// ---------------------------------------------------------------------------

struct PathKeyMirror {
    address intermediateCurrency;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
    bytes hookData;
}

struct ExactInputSingleMirror {
    address currencyIn;
    PathKeyMirror[] path;
    uint256[] minHopPriceX36;
    uint128 amountIn;
    uint128 amountOutMinimum;
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------

contract WizPayPayrollMainnetTest is Test {
    address internal constant SAFE = address(0x5AFE);
    uint24 internal constant POOL_FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    uint256 internal constant SUPPLY = 10_000_000e6;
    uint256 internal constant FEE_BPS = 25;
    uint256 internal constant MIN_HOP = 1e36;
    uint256 internal constant SCALE = 1_000_000_000_000;

    bytes4 internal guardSelector;

    address internal employer;
    address internal employer2;
    address internal alice;
    address internal bob;
    address internal carol;

    MockERC20 internal usdc;
    MockERC20 internal eurc;
    MockPermit2 internal permit2;
    MockPoolManager internal poolManager;
    MockPayrollRouter internal router;
    WizPayPayrollMainnet internal payroll;

    bytes32 internal constant REF_CONSUMED_SIG = keccak256(
        "PayrollReferenceConsumed(bytes32,address,address,address,bytes32,uint256,uint256,uint256,uint256,string)"
    );

    function setUp() public {
        vm.chainId(5_042);
        vm.etch(SAFE, hex"00");
        guardSelector = bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        employer = makeAddr("employer");
        employer2 = makeAddr("employer2");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        usdc = new MockERC20("USDC", "USDC", 6, SUPPLY);
        eurc = new MockERC20("EURC", "EURC", 6, SUPPLY);
        permit2 = new MockPermit2();
        poolManager = new MockPoolManager();
        router = new MockPayrollRouter(usdc, eurc, permit2, address(poolManager));

        payroll = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            POOL_FEE,
            TICK_SPACING
        );
        vm.prank(SAFE);
        payroll.unpause();

        usdc.transfer(employer, 1_000_000e6);
        eurc.transfer(employer, 1_000_000e6);
        usdc.transfer(employer2, 1_000_000e6);
        eurc.transfer(employer2, 1_000_000e6);
        usdc.transfer(address(router), 2_000_000e6);
        eurc.transfer(address(router), 2_000_000e6);
    }

    // =====================================================================
    // Constructor / deployment safety
    // =====================================================================

    function testConstructorSetsState() public view {
        assertEq(payroll.USDC(), address(usdc));
        assertEq(payroll.EURC(), address(eurc));
        assertEq(address(payroll.universalRouter()), address(router));
        assertEq(address(payroll.permit2()), address(permit2));
        assertEq(payroll.poolManager(), address(poolManager));
        assertEq(payroll.poolFee(), POOL_FEE);
        assertEq(payroll.poolTickSpacing(), TICK_SPACING);
        assertEq(payroll.feeRecipient(), SAFE);
        assertEq(payroll.feeBps(), FEE_BPS);
        assertEq(payroll.owner(), SAFE);
    }

    function testConstructorStartsPaused() public {
        WizPayPayrollMainnet fresh = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
        assertTrue(fresh.paused());
    }

    function testConstructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.WrongChain.selector, uint256(1)));
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
    }

    function testConstructorRejectsEoaOwner() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.InitialOwnerMustBeContract.selector, eoa));
        new WizPayPayrollMainnet(
            eoa,
            eoa,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
    }

    function testConstructorRejectsFeeRecipientMismatch() public {
        vm.expectRevert(
            abi.encodeWithSelector(WizPayPayrollMainnet.FeeRecipientMustEqualOwner.selector, address(2), address(1))
        );
        new WizPayPayrollMainnet(
            address(1),
            address(2),
            25,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
    }

    function testConstructorRejectsExcessiveFee() public {
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.FeeExceedsMaximum.selector, 101, 100));
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            101,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
    }

    function testConstructorRejectsZeroResources() public {
        vm.expectRevert(bytes("bad tokens"));
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(0),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
        vm.expectRevert(bytes("bad infra"));
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(0),
            address(permit2),
            address(poolManager),
            500,
            10
        );
    }

    function testConstructorRejectsNoCodeResource() public {
        address noCode = address(0xCAFE);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.ResourceHasNoCode.selector, noCode));
        new WizPayPayrollMainnet(
            SAFE, SAFE, FEE_BPS, address(usdc), address(eurc), noCode, address(permit2), address(poolManager), 500, 10
        );
    }

    function testConstructorRejectsWrongPoolFee() public {
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.InvalidPoolFee.selector, uint24(3000)));
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            3000,
            10
        );
    }

    function testConstructorRejectsWrongTickSpacing() public {
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.InvalidPoolTickSpacing.selector, int24(60)));
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            60
        );
    }

    function testConstructorBindsRouterPoolManager() public view {
        assertEq(router.poolManager(), address(poolManager));
        assertEq(payroll.poolManager(), address(poolManager));
    }

    function testConstructorRejectsRouterPoolManagerMismatch() public {
        MockPoolManager other = new MockPoolManager();
        vm.expectRevert(
            abi.encodeWithSelector(
                WizPayPayrollMainnet.RouterPoolManagerMismatch.selector, address(other), address(poolManager)
            )
        );
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(other),
            500,
            10
        );
    }

    function testConstructorRejectsMismatchedRouterBinding() public {
        MockPoolManager roguePm = new MockPoolManager();
        MockPayrollRouter rogueRouter = new MockPayrollRouter(usdc, eurc, permit2, address(roguePm));
        vm.expectRevert(
            abi.encodeWithSelector(
                WizPayPayrollMainnet.RouterPoolManagerMismatch.selector, address(poolManager), address(roguePm)
            )
        );
        new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            FEE_BPS,
            address(usdc),
            address(eurc),
            address(rogueRouter),
            address(permit2),
            address(poolManager),
            500,
            10
        );
    }

    function testOwnershipLocked() public {
        vm.startPrank(SAFE);
        vm.expectRevert(WizPayPayrollMainnet.OwnershipLocked.selector);
        payroll.transferOwnership(employer);
        vm.expectRevert(WizPayPayrollMainnet.OwnershipLocked.selector);
        payroll.renounceOwnership();
        vm.stopPrank();
    }

    function testOnlyOwnerPauseUnpause() public {
        vm.expectRevert();
        vm.prank(employer);
        payroll.pause();
        vm.expectRevert();
        vm.prank(employer);
        payroll.unpause();
        vm.prank(SAFE);
        payroll.pause();
        assertTrue(payroll.paused());
        vm.prank(SAFE);
        payroll.unpause();
        assertFalse(payroll.paused());
    }

    function testPauseBlocksPayroll() public {
        vm.prank(SAFE);
        payroll.pause();
        vm.expectRevert();
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), _recipients2(), _amounts(100e6, 200e6), "PAUSED");
    }

    function testRescueBlockedForCanonical() public {
        MockERC20 stray = new MockERC20("S", "S", 6, 100);
        stray.transfer(address(payroll), 10);
        vm.startPrank(SAFE);
        payroll.pause();
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.TokenRescueBlocked.selector, address(usdc)));
        payroll.rescueTokens(address(usdc), SAFE, 1);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.TokenRescueBlocked.selector, address(eurc)));
        payroll.rescueTokens(address(eurc), SAFE, 1);
        payroll.rescueTokens(address(stray), SAFE, 10);
        vm.stopPrank();
        assertEq(stray.balanceOf(SAFE), 10);
    }

    function testRescueOnlyWhenPaused() public {
        MockERC20 stray = new MockERC20("S", "S", 6, 100);
        stray.transfer(address(payroll), 10);
        vm.expectRevert();
        vm.prank(SAFE);
        payroll.rescueTokens(address(stray), SAFE, 10);
    }

    function testExpectedCommandActionBytes() public view {
        assertEq(payroll.expectedCommands(), abi.encodePacked(uint8(0x10)));
        assertEq(payroll.expectedActions(), abi.encodePacked(uint8(0x07), uint8(0x0b), uint8(0x0e)));
    }

    // =====================================================================
    // Same-token: exact-obligation semantics
    // amounts[] are exact recipient obligations; employer pays fee on top.
    // =====================================================================

    function testSameTokenUsdcHappy() public {
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(100e6, 200e6);
        uint256 feeA = (100e6 * FEE_BPS) / 10_000;
        uint256 feeB = (200e6 * FEE_BPS) / 10_000;
        uint256 funding = 300e6 + feeA + feeB;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        uint256 employerBefore = usdc.balanceOf(employer);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 safeBefore = usdc.balanceOf(SAFE);
        vm.prank(employer);
        uint256 out = payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "USDC-1");
        assertEq(out, 300e6, "totalOut equals exact obligations");
        assertEq(usdc.balanceOf(alice), aliceBefore + 100e6, "alice receives exactly her obligation");
        assertEq(usdc.balanceOf(bob), bobBefore + 200e6, "bob receives exactly his obligation");
        assertEq(usdc.balanceOf(SAFE), safeBefore + feeA + feeB, "fee paid on top");
        assertEq(employerBefore - usdc.balanceOf(employer), funding, "employer debit is obligations plus fee");
        assertEq(usdc.balanceOf(address(payroll)), 0);
        assertEq(eurc.balanceOf(address(payroll)), 0);
    }

    function testSameTokenExact100UsdcObligation() public {
        address[] memory recipients = _singleAddr(alice);
        uint256[] memory amounts = _single(100e6);
        uint256 fee = (100e6 * FEE_BPS) / 10_000;
        assertEq(fee, 250_000);
        uint256 funding = 100e6 + fee;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        uint256 employerBefore = usdc.balanceOf(employer);
        vm.prank(employer);
        uint256 out = payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "EXACT-100");
        assertEq(usdc.balanceOf(alice), 100e6, "100 USDC obligation arrives exactly");
        assertEq(out, 100e6);
        assertEq(employerBefore - usdc.balanceOf(employer), funding, "employer pays 100 USDC plus fee");
        assertEq(usdc.balanceOf(SAFE), fee);
    }

    function testSameTokenEurcHappy() public {
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(50e6, 75e6);
        uint256 feeA = (50e6 * FEE_BPS) / 10_000;
        uint256 feeB = (75e6 * FEE_BPS) / 10_000;
        uint256 funding = 125e6 + feeA + feeB;
        vm.prank(employer);
        eurc.approve(address(payroll), funding);
        vm.prank(employer);
        uint256 out = payroll.executeSameTokenPayroll(address(eurc), recipients, amounts, "EURC-1");
        assertEq(out, 125e6);
        assertEq(eurc.balanceOf(alice), 50e6, "alice receives exactly her obligation");
        assertEq(eurc.balanceOf(bob), 75e6, "bob receives exactly his obligation");
        assertEq(eurc.balanceOf(SAFE), feeA + feeB);
        assertEq(eurc.balanceOf(address(payroll)), 0);
    }

    function testSameTokenZeroFee() public {
        WizPayPayrollMainnet zeroFee = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            0,
            address(usdc),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
        vm.prank(SAFE);
        zeroFee.unpause();
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(7, 11);
        vm.prank(employer);
        usdc.approve(address(zeroFee), 18);
        uint256 employerBefore = usdc.balanceOf(employer);
        vm.prank(employer);
        uint256 out = zeroFee.executeSameTokenPayroll(address(usdc), recipients, amounts, "NO-FEE");
        assertEq(out, 18);
        assertEq(usdc.balanceOf(alice), 7);
        assertEq(usdc.balanceOf(bob), 11);
        assertEq(employerBefore - usdc.balanceOf(employer), 18, "zero fee: debit equals obligations");
    }

    function testSameTokenRounding() public {
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(999, 10_001);
        uint256 fees = (999 * FEE_BPS) / 10_000 + (10_001 * FEE_BPS) / 10_000;
        assertEq(fees, 27);
        uint256 funding = 11_000 + fees;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        uint256 out = payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "ROUND");
        assertEq(out, 11_000, "recipients receive exact obligations despite rounding");
        assertEq(usdc.balanceOf(alice), 999);
        assertEq(usdc.balanceOf(bob), 10_001);
        assertEq(usdc.balanceOf(SAFE), fees);
        assertEq(usdc.balanceOf(address(payroll)), 0);
    }

    function testSameTokenMultiRecipientConservation() public {
        address[] memory recipients = new address[](3);
        recipients[0] = alice;
        recipients[1] = bob;
        recipients[2] = carol;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 111e6;
        amounts[1] = 222e6;
        amounts[2] = 333e6;
        uint256 fees = (111e6 * FEE_BPS) / 10_000 + (222e6 * FEE_BPS) / 10_000 + (333e6 * FEE_BPS) / 10_000;
        uint256 funding = 666e6 + fees;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        uint256 employerBefore = usdc.balanceOf(employer);
        uint256 safeBefore = usdc.balanceOf(SAFE);
        vm.prank(employer);
        uint256 out = payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "MULTI");
        assertEq(out, 666e6);
        assertEq(usdc.balanceOf(alice), 111e6);
        assertEq(usdc.balanceOf(bob), 222e6);
        assertEq(usdc.balanceOf(carol), 333e6);
        assertEq(usdc.balanceOf(SAFE) - safeBefore, fees);
        assertEq(employerBefore - usdc.balanceOf(employer), funding);
        assertEq(usdc.balanceOf(address(payroll)), 0);
    }

    function testSameTokenEventsReportFundingSemantics() public {
        address[] memory recipients = _singleAddr(alice);
        uint256[] memory amounts = _single(100e6);
        uint256 fee = (100e6 * FEE_BPS) / 10_000;
        uint256 funding = 100e6 + fee;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.recordLogs();
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "EVT");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        uint256 evInput;
        uint256 evOutput;
        uint256 evFees;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == REF_CONSUMED_SIG) {
                (,, uint256 totalInput, uint256 totalOutput, uint256 totalFees,,) =
                    abi.decode(logs[i].data, (address, bytes32, uint256, uint256, uint256, uint256, string));
                evInput = totalInput;
                evOutput = totalOutput;
                evFees = totalFees;
                found = true;
            }
        }
        assertTrue(found, "PayrollReferenceConsumed emitted");
        assertEq(evInput, funding, "totalInput is obligations plus fee");
        assertEq(evOutput, 100e6, "totalOutput is exact obligations");
        assertEq(evFees, fee, "totalFees reported");
    }

    function testSameTokenNoUniswapCall() public {
        uint256 callsBefore = router.callCount();
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(10e6, 20e6);
        uint256 funding = 30e6 + (10e6 * FEE_BPS) / 10_000 + (20e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "NO-SWAP");
        assertEq(router.callCount(), callsBefore);
    }

    // =====================================================================
    // Same-token validation
    // =====================================================================

    function testSameTokenRejectsUnsupportedToken() public {
        MockERC20 other = new MockERC20("X", "X", 6, 100);
        vm.expectRevert(
            abi.encodeWithSelector(WizPayPayrollMainnet.UnsupportedPayrollPair.selector, address(other), address(other))
        );
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(other), _recipients2(), _amounts(1, 1), "BAD");
    }

    function testSameTokenRejectsNativeValue() public {
        vm.deal(employer, 1);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.NativeMsgValueMismatch.selector, 1, 0));
        vm.prank(employer);
        payroll.executeSameTokenPayroll{value: 1}(address(usdc), _recipients2(), _amounts(1, 1), "NATIVE");
    }

    function testSameTokenValidation() public {
        address[] memory emptyA = new address[](0);
        uint256[] memory emptyU = new uint256[](0);
        vm.expectRevert(WizPayPayrollMainnet.EmptyBatch.selector);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), emptyA, emptyU, "EMPTY");

        address[] memory one = new address[](1);
        one[0] = alice;
        uint256[] memory two = new uint256[](2);
        two[0] = 1;
        two[1] = 2;
        vm.expectRevert(WizPayPayrollMainnet.ArrayLengthMismatch.selector);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), one, two, "MISMATCH");

        address[] memory many = new address[](51);
        uint256[] memory manyU = new uint256[](51);
        for (uint256 i; i < 51; ++i) {
            many[i] = alice;
            manyU[i] = 1;
        }
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.BatchTooLarge.selector, 51, 50));
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), many, manyU, "LARGE");

        address[] memory zeroR = new address[](1);
        zeroR[0] = address(0);
        vm.expectRevert(WizPayPayrollMainnet.RecipientZeroAddress.selector);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), zeroR, _single(1), "ZERO-R");

        address[] memory selfR = new address[](1);
        selfR[0] = employer;
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.SelfPaymentNotAllowed.selector, employer));
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), selfR, _single(1), "SELF");

        address[] memory contractR = new address[](1);
        contractR[0] = address(payroll);
        vm.expectRevert(
            abi.encodeWithSelector(WizPayPayrollMainnet.ContractRecipientNotAllowed.selector, address(payroll))
        );
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), contractR, _single(1), "CONTRACT");

        address[] memory okR = new address[](1);
        okR[0] = alice;
        uint256[] memory zeroA = new uint256[](1);
        zeroA[0] = 0;
        vm.expectRevert(WizPayPayrollMainnet.AmountMustBeGreaterThanZero.selector);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), okR, zeroA, "ZERO-A");

        vm.expectRevert(WizPayPayrollMainnet.ReferenceIdRequired.selector);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), okR, _single(1), "");

        string memory longRef = "12345678901234567890123456789012345678901234567890123456789012345";
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.ReferenceIdTooLong.selector, 65, 64));
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), okR, _single(1), longRef);
    }

    function testSameTokenDuplicateRecipientsAllowed() public {
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = alice;
        uint256[] memory amounts = _amounts(100e6, 200e6);
        uint256 funding = 300e6 + (100e6 * FEE_BPS) / 10_000 + (200e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "DUP");
        assertEq(usdc.balanceOf(alice), 300e6, "both line items arrive exactly");
    }

    function testSameTokenReplay() public {
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(10e6, 20e6);
        uint256 funding = 30e6 + (10e6 * FEE_BPS) / 10_000 + (20e6 * FEE_BPS) / 10_000;
        bytes32 h = payroll.canonicalReferenceHash(employer, "REPLAY");
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "REPLAY");
        assertTrue(payroll.usedReferenceHashes(h));
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.ReferenceAlreadyUsed.selector, h));
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "REPLAY");
    }

    function testSameTokenRevertedDoesNotConsume() public {
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(10e6, 20e6);
        bytes32 h = payroll.canonicalReferenceHash(employer, "RETRY");
        vm.prank(employer);
        usdc.approve(address(payroll), 1);
        vm.expectRevert();
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "RETRY");
        assertFalse(payroll.usedReferenceHashes(h));
        uint256 funding = 30e6 + (10e6 * FEE_BPS) / 10_000 + (20e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "RETRY");
        assertTrue(payroll.usedReferenceHashes(h));
    }

    function testSameTokenPreexistingResidualNotSubsidizing() public {
        usdc.transfer(address(payroll), 123);
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(10e6, 20e6);
        uint256 funding = 30e6 + (10e6 * FEE_BPS) / 10_000 + (20e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "RESID");
        assertEq(usdc.balanceOf(address(payroll)), 123, "residual untouched");
        assertEq(usdc.balanceOf(alice), 10e6, "obligation exact despite residual");
        assertEq(usdc.balanceOf(bob), 20e6, "obligation exact despite residual");
    }

    function testSameTokenResidualCannotReplaceFunding() public {
        // Payroll holds a large pre-existing balance, but the employer approves
        // only the obligations without the fee on top: funding must revert and
        // the residual must remain untouched.
        usdc.transfer(address(payroll), 1_000_000e6);
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(10e6, 20e6);
        vm.prank(employer);
        usdc.approve(address(payroll), 30e6);
        vm.expectRevert();
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, "NOSUB");
        assertEq(usdc.balanceOf(address(payroll)), 1_000_000e6);
        assertFalse(payroll.usedReferenceHashes(payroll.canonicalReferenceHash(employer, "NOSUB")));
    }

    function testSameTokenFeeOnTransferReverts() public {
        FeeOnTransferToken token = new FeeOnTransferToken();
        token.mint(employer, 200);
        token.mint(address(this), 10);
        WizPayPayrollMainnet target = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            0,
            address(token),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
        vm.prank(SAFE);
        target.unpause();
        token.transfer(address(target), 10);
        vm.prank(employer);
        token.approve(address(target), 100);
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100;
        vm.expectRevert();
        vm.prank(employer);
        target.executeSameTokenPayroll(address(token), recipients, amounts, "TAXED");
        assertEq(token.balanceOf(address(target)), 10);
    }

    function testSameTokenFalseReturnReverts() public {
        FalseReturnToken bad = new FalseReturnToken();
        bad.mint(employer, 100);
        WizPayPayrollMainnet target = new WizPayPayrollMainnet(
            SAFE, SAFE, 0, address(bad), address(eurc), address(router), address(permit2), address(poolManager), 500, 10
        );
        vm.prank(SAFE);
        target.unpause();
        vm.prank(employer);
        bad.approve(address(target), 100);
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100;
        vm.expectRevert();
        vm.prank(employer);
        target.executeSameTokenPayroll(address(bad), recipients, amounts, "FALSE");
        assertFalse(target.usedReferenceHashes(target.canonicalReferenceHash(employer, "FALSE")));
    }

    function testSameTokenReentrancyGuardBlocksValidNestedCall() public {
        // Zero-fee target so the nested payroll needs no fee math: funding 100.
        ReentrantPayrollToken token = new ReentrantPayrollToken();
        WizPayPayrollMainnet target = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            0,
            address(token),
            address(eurc),
            address(router),
            address(permit2),
            address(poolManager),
            500,
            10
        );
        vm.prank(SAFE);
        target.unpause();
        token.setTarget(target);
        // Nested call prerequisites: token contract holds funds and approves payroll.
        token.mint(address(token), 1_000);
        token.mint(employer, 100);
        vm.prank(address(token));
        token.approve(address(target), 1_000);
        vm.prank(employer);
        token.approve(address(target), 100);
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100;
        vm.prank(employer);
        target.executeSameTokenPayroll(address(token), recipients, amounts, "OUTER");
        // The nested call was fully valid (funded, approved, fresh reference,
        // valid recipient) yet failed specifically on the guard...
        assertTrue(token.nestedAttempted(), "nested call attempted");
        assertFalse(token.nestedSucceeded(), "nested call blocked");
        assertEq(bytes4(token.nestedRevertData()), guardSelector, "blocked by ReentrancyGuard");
        // ...while the outer payroll completed exactly.
        assertEq(token.balanceOf(alice), 100, "outer obligation exact");
    }

    // =====================================================================
    // Global reference replay domain (route-independent)
    // =====================================================================

    function testReferenceConsumedOnUsdcBlocksEurcReuse() public {
        address[] memory recipients = _recipients2();
        uint256 funding = 30e6 + (10e6 * FEE_BPS) / 10_000 + (20e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), recipients, _amounts(10e6, 20e6), "GLOBAL-REF");
        bytes32 h = payroll.canonicalReferenceHash(employer, "GLOBAL-REF");
        assertTrue(payroll.usedReferenceHashes(h));
        // Same reference on another same-token pair must revert.
        uint256 eurcFunding = 30e6 + (10e6 * FEE_BPS) / 10_000 + (20e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        eurc.approve(address(payroll), eurcFunding);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.ReferenceAlreadyUsed.selector, h));
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(eurc), recipients, _amounts(10e6, 20e6), "GLOBAL-REF");
    }

    function testReferenceConsumedOnSameTokenBlocksCrossTokenReuse() public {
        uint256 funding = 30e6 + (10e6 * FEE_BPS) / 10_000 + (20e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), _recipients2(), _amounts(10e6, 20e6), "XROUTE-REF");
        bytes32 h = payroll.canonicalReferenceHash(employer, "XROUTE-REF");
        // Same reference on a fully-valid cross-token payroll must revert.
        uint256 gross = 1_000e6;
        uint256 native = gross * SCALE;
        vm.deal(employer, native);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.ReferenceAlreadyUsed.selector, h));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "XROUTE-REF"
        );
    }

    function testDifferentEmployersShareHumanReferenceId() public {
        uint256 funding = 10e6 + (10e6 * FEE_BPS) / 10_000;
        vm.prank(employer);
        usdc.approve(address(payroll), funding);
        vm.prank(employer);
        payroll.executeSameTokenPayroll(address(usdc), _singleAddr(alice), _single(10e6), "SHARED-REF");
        vm.prank(employer2);
        usdc.approve(address(payroll), funding);
        vm.prank(employer2);
        payroll.executeSameTokenPayroll(address(usdc), _singleAddr(alice), _single(10e6), "SHARED-REF");
        assertEq(usdc.balanceOf(alice), 20e6);
    }

    // =====================================================================
    // Cross-token happy paths
    // =====================================================================

    function testCrossUsdcToEurcHappy() public {
        uint256 gross = 1_000e6;
        uint256 fee = (gross * FEE_BPS) / 10_000;
        uint256 net = gross - fee;
        uint256 outA = 400e6;
        uint256 outB = 500e6;
        uint256 totalOut = outA + outB;
        router.configure(totalOut);

        address[] memory recipients = _recipients2();
        uint256[] memory outputs = _amounts(outA, outB);
        uint256 native = gross * SCALE;
        vm.deal(employer, native);

        uint256 safeBefore = SAFE.balance;
        uint256 aliceBefore = eurc.balanceOf(alice);
        vm.prank(employer);
        uint256 amountOut = payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            recipients,
            outputs,
            gross,
            totalOut,
            MIN_HOP,
            block.timestamp + 10 minutes,
            "X-USDC"
        );
        assertEq(amountOut, totalOut);
        assertEq(SAFE.balance, safeBefore + fee * SCALE);
        assertEq(router.lastValue(), net * SCALE);
        assertEq(eurc.balanceOf(alice), aliceBefore + outA);
        assertEq(eurc.balanceOf(bob), outB);
        assertEq(eurc.balanceOf(address(payroll)), 0);
        assertEq(address(payroll).balance, 0);
        assertEq(router.callCount(), 1);
        (address c, address r,) = abi.decode(router.lastTakeParam(), (address, address, uint256));
        assertEq(c, address(eurc));
        assertEq(r, address(payroll));
    }

    function testCrossEurcToUsdcHappy() public {
        uint256 gross = 1_000e6;
        uint256 fee = (gross * FEE_BPS) / 10_000;
        uint256 outA = 500e6;
        uint256 outB = 600e6;
        router.configure(outA + outB);

        address[] memory recipients = _recipients2();
        uint256[] memory outputs = _amounts(outA, outB);
        vm.prank(employer);
        eurc.approve(address(payroll), gross);
        uint256 safeBefore = eurc.balanceOf(SAFE);
        vm.prank(employer);
        uint256 amountOut = payroll.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            recipients,
            outputs,
            gross,
            outA + outB,
            MIN_HOP,
            block.timestamp + 10 minutes,
            "X-EURC"
        );
        assertEq(amountOut, outA + outB);
        assertEq(eurc.balanceOf(SAFE), safeBefore + fee);
        assertEq(usdc.balanceOf(alice), outA);
        assertEq(usdc.balanceOf(bob), outB);
        assertEq(eurc.balanceOf(address(payroll)), 0);
        assertEq(usdc.balanceOf(address(payroll)), 0);
        assertEq(eurc.allowance(address(payroll), address(permit2)), 0);
        (uint160 p2,,) = permit2.allowance(address(payroll), address(eurc), address(router));
        assertEq(p2, 0);
    }

    function testCrossEncodingPoolKeyAndFlags() public {
        router.configure(900e6);
        uint256 gross = 1_000e6;
        uint256 native = gross * SCALE;
        vm.deal(employer, native);
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "ENC"
        );
        ExactInputSingleMirror memory p = abi.decode(router.lastSwapExactInParam(), (ExactInputSingleMirror));
        assertEq(p.currencyIn, address(usdc));
        assertEq(p.path.length, 1);
        assertEq(p.path[0].intermediateCurrency, address(eurc));
        assertEq(uint24(p.path[0].fee), 500);
        assertEq(int24(p.path[0].tickSpacing), 10);
        assertEq(p.path[0].hooks, address(0));
        (,, bool payerIsUser) = abi.decode(router.lastSettleParam(), (address, uint256, bool));
        assertFalse(payerIsUser);
    }

    function testCrossEurcSettleFlag() public {
        router.configure(1_000e6);
        vm.prank(employer);
        eurc.approve(address(payroll), 1_000e6);
        vm.prank(employer);
        payroll.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(400e6, 500e6),
            1_000e6,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "ENC2"
        );
        (,, bool payerIsUser) = abi.decode(router.lastSettleParam(), (address, uint256, bool));
        assertTrue(payerIsUser);
    }

    function testCrossSurplusRefund() public {
        uint256 gross = 1_000e6;
        uint256 outA = 400e6;
        uint256 outB = 400e6;
        uint256 delivered = 1_000e6;
        router.configure(delivered);
        uint256 native = gross * SCALE;
        vm.deal(employer, native);
        uint256 employerEurcBefore = eurc.balanceOf(employer);
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(outA, outB),
            gross,
            outA + outB,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "SURPLUS"
        );
        assertEq(eurc.balanceOf(employer), employerEurcBefore + (delivered - outA - outB));
        assertEq(eurc.balanceOf(address(payroll)), 0);
    }

    // =====================================================================
    // Cross-token intent digest
    // =====================================================================

    function testCrossTokenEmitsFullIntentDigest() public {
        uint256 gross = 1_000e6;
        uint256 outA = 400e6;
        uint256 outB = 500e6;
        uint256 minOut = 900e6;
        uint256 deadline = block.timestamp + 5 minutes;
        router.configure(900e6);
        uint256 native = gross * SCALE;
        vm.deal(employer, native);
        address[] memory recipients = _recipients2();
        uint256[] memory outputs = _amounts(outA, outB);
        vm.recordLogs();
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc), address(eurc), recipients, outputs, gross, minOut, MIN_HOP, deadline, "INTENT"
        );
        bytes32 expected = payroll.canonicalCrossTokenDigest(
            employer, address(usdc), address(eurc), recipients, outputs, gross, minOut, MIN_HOP, deadline, "INTENT"
        );
        bytes32 emitted = _findReferenceConsumedDigest(vm.getRecordedLogs());
        assertEq(emitted, expected, "emitted digest is the full intent digest");
    }

    function testCrossTokenDigestBindsEverySwapParameter() public view {
        address[] memory recipients = _recipients2();
        uint256[] memory outputs = _amounts(400e6, 500e6);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 base = payroll.canonicalCrossTokenDigest(
            employer, address(usdc), address(eurc), recipients, outputs, 1_000e6, 900e6, MIN_HOP, deadline, "D"
        );
        address[] memory swapped = new address[](2);
        swapped[0] = bob;
        swapped[1] = alice;
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer, address(usdc), address(eurc), swapped, outputs, 1_000e6, 900e6, MIN_HOP, deadline, "D"
            ),
            "recipient order bound"
        );
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer,
                address(usdc),
                address(eurc),
                recipients,
                _amounts(400e6, 500_001),
                1_000e6,
                900e6,
                MIN_HOP,
                deadline,
                "D"
            ),
            "output amounts bound"
        );
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer, address(usdc), address(eurc), recipients, outputs, 1_000_001, 900e6, MIN_HOP, deadline, "D"
            ),
            "grossInput bound"
        );
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer, address(usdc), address(eurc), recipients, outputs, 1_000e6, 900_001, MIN_HOP, deadline, "D"
            ),
            "minTotalOut bound"
        );
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer, address(usdc), address(eurc), recipients, outputs, 1_000e6, 900e6, MIN_HOP + 1, deadline, "D"
            ),
            "minHopPriceX36 bound"
        );
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer, address(usdc), address(eurc), recipients, outputs, 1_000e6, 900e6, MIN_HOP, deadline + 1, "D"
            ),
            "deadline bound"
        );
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer, address(eurc), address(usdc), recipients, outputs, 1_000e6, 900e6, MIN_HOP, deadline, "D"
            ),
            "token pair bound"
        );
        assertNotEq(
            base,
            payroll.canonicalCrossTokenDigest(
                employer, address(usdc), address(eurc), recipients, outputs, 1_000e6, 900e6, MIN_HOP, deadline, "OTHER"
            ),
            "reference bound"
        );
        assertNotEq(
            base,
            payroll.canonicalBatchDigest(employer, address(usdc), address(eurc), recipients, outputs, "D"),
            "intent digest differs from plain batch digest"
        );
    }

    // =====================================================================
    // Cross-token failure modes
    // =====================================================================

    function testCrossInsufficientOutputRevertsNoPartial() public {
        uint256 gross = 1_000e6;
        router.configure(500e6);
        uint256 native = gross * SCALE;
        vm.deal(employer, native);
        uint256 aliceBefore = eurc.balanceOf(alice);
        uint256 bobBefore = eurc.balanceOf(bob);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.InsufficientSwapOutput.selector, 500e6, 900e6));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "INSUF"
        );
        // No partial payouts: recipients unchanged, reference not consumed.
        assertEq(eurc.balanceOf(alice), aliceBefore);
        assertEq(eurc.balanceOf(bob), bobBefore);
        assertFalse(payroll.usedReferenceHashes(payroll.canonicalReferenceHash(employer, "INSUF")));
    }

    function testCrossSlippageReverts() public {
        uint256 gross = 1_000e6;
        router.configure(800e6);
        uint256 native = gross * SCALE;
        vm.deal(employer, native);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.SlippageExceeded.selector, 800e6, 900e6));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 400e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "SLIP"
        );
    }

    function testCrossMinBelowObligationsReverts() public {
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.MinTotalOutBelowObligations.selector, 700e6, 900e6));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(400e6, 500e6),
            1_000e6,
            700e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "MINLOW"
        );
    }

    function testCrossDeadlineValidation() public {
        vm.warp(200);
        vm.deal(employer, 1_000e6 * SCALE);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.DeadlineExpired.selector, 199, 200));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: 1_000e6 * SCALE}(
            address(usdc), address(eurc), _recipients2(), _amounts(1, 1), 1_000e6, 2, MIN_HOP, 199, "EXP"
        );
        uint256 max = block.timestamp + payroll.MAX_DEADLINE_WINDOW();
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.DeadlineTooFar.selector, max + 1, max));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: 1_000e6 * SCALE}(
            address(usdc), address(eurc), _recipients2(), _amounts(1, 1), 1_000e6, 2, MIN_HOP, max + 1, "FAR"
        );
    }

    function testCrossWrongPairReverts() public {
        MockERC20 other = new MockERC20("X", "X", 6, 100);
        vm.expectRevert(
            abi.encodeWithSelector(WizPayPayrollMainnet.UnsupportedPayrollPair.selector, address(other), address(eurc))
        );
        vm.prank(employer);
        payroll.executeCrossTokenPayroll(
            address(other), address(eurc), _recipients2(), _amounts(1, 1), 1, 2, MIN_HOP, block.timestamp + 1, "BAD"
        );
        vm.expectRevert(
            abi.encodeWithSelector(WizPayPayrollMainnet.UnsupportedPayrollPair.selector, address(usdc), address(usdc))
        );
        vm.prank(employer);
        payroll.executeCrossTokenPayroll(
            address(usdc), address(usdc), _recipients2(), _amounts(1, 1), 1, 2, MIN_HOP, block.timestamp + 1, "SAME"
        );
    }

    function testCrossNativeMismatch() public {
        uint256 gross = 1_000e6;
        uint256 correct = gross * SCALE;
        vm.deal(employer, correct + 1);
        vm.expectRevert(
            abi.encodeWithSelector(WizPayPayrollMainnet.NativeMsgValueMismatch.selector, correct + 1, correct)
        );
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: correct + 1}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(1, 1),
            gross,
            2,
            MIN_HOP,
            block.timestamp + 1,
            "NATIV"
        );
    }

    function testCrossEurcNonZeroValueReverts() public {
        vm.prank(employer);
        eurc.approve(address(payroll), 1_000e6);
        vm.deal(employer, 1);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.NativeMsgValueMismatch.selector, 1, 0));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: 1}(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(1, 1),
            1_000e6,
            2,
            MIN_HOP,
            block.timestamp + 1,
            "NATIV2"
        );
    }

    function testCrossUint128Bounds() public {
        uint256 tooLarge = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.AmountInExceedsUint128.selector, tooLarge));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(1, 1),
            tooLarge,
            2,
            MIN_HOP,
            block.timestamp + 1,
            "BIG"
        );
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.MinAmountOutExceedsUint128.selector, tooLarge));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(1, 1),
            1_000e6,
            tooLarge,
            MIN_HOP,
            block.timestamp + 1,
            "BIG2"
        );
    }

    function testCrossReplayAndRetry() public {
        router.configure(900e6);
        uint256 gross = 1_000e6;
        uint256 native = gross * SCALE;
        vm.deal(employer, native * 2);
        bytes32 h = payroll.canonicalReferenceHash(employer, "REPLAYX");
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "REPLAYX"
        );
        assertTrue(payroll.usedReferenceHashes(h));
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.ReferenceAlreadyUsed.selector, h));
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "REPLAYX"
        );
    }

    function testCrossRevertedDoesNotConsume() public {
        router.configure(100e6);
        uint256 gross = 1_000e6;
        uint256 native = gross * SCALE;
        vm.deal(employer, native * 2);
        bytes32 h = payroll.canonicalReferenceHash(employer, "RETRYX");
        vm.expectRevert();
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            500e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "RETRYX"
        );
        assertFalse(payroll.usedReferenceHashes(h));
        router.configure(900e6);
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "RETRYX"
        );
        assertTrue(payroll.usedReferenceHashes(h));
    }

    function testCrossBypassRouterRevertsAtomically() public {
        BypassRouter bypass = new BypassRouter(usdc, permit2, carol, address(poolManager));
        WizPayPayrollMainnet target = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            0,
            address(usdc),
            address(eurc),
            address(bypass),
            address(permit2),
            address(poolManager),
            500,
            10
        );
        vm.prank(SAFE);
        target.unpause();
        usdc.transfer(address(bypass), 1_000e6);
        vm.prank(employer);
        eurc.approve(address(target), 1_000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);
        // Payroll sees zero output (bypass went to outsider); entire tx reverts
        // atomically, so the bypass delivery is rolled back too.
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.InsufficientSwapOutput.selector, 0, 200e6));
        vm.prank(employer);
        target.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(100e6, 100e6),
            1_000e6,
            200e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "BYPASS"
        );
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertEq(usdc.balanceOf(bob), bobBefore);
        assertEq(usdc.balanceOf(carol), carolBefore);
        assertFalse(target.usedReferenceHashes(target.canonicalReferenceHash(employer, "BYPASS")));
    }

    function testCrossResidualInputReverts() public {
        ResidualInputRouter residual = new ResidualInputRouter(usdc, address(poolManager));
        MockPermit2 localP2 = new MockPermit2();
        WizPayPayrollMainnet target = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            0,
            address(usdc),
            address(eurc),
            address(residual),
            address(localP2),
            address(poolManager),
            500,
            10
        );
        vm.prank(SAFE);
        target.unpause();
        usdc.transfer(address(residual), 10_000e6);
        vm.prank(employer);
        eurc.approve(address(target), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(WizPayPayrollMainnet.ResidualInputBalance.selector, 0, 1_000e6));
        vm.prank(employer);
        target.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(100e6, 100e6),
            1_000e6,
            200e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "RESIN"
        );
    }

    function testCrossReentrancyGuardBlocksValidNestedCall() public {
        // Zero-fee target so the nested payroll needs no fee math: funding 100.
        ReentrantPayrollRouter placeholder = new ReentrantPayrollRouter(usdc, eurc, permit2, address(poolManager), usdc);
        WizPayPayrollMainnet target = new WizPayPayrollMainnet(
            SAFE,
            SAFE,
            0,
            address(usdc),
            address(eurc),
            address(placeholder),
            address(permit2),
            address(poolManager),
            500,
            10
        );
        vm.prank(SAFE);
        target.unpause();
        placeholder.setPayroll(target);
        // Nested call prerequisites: router holds funds and approves payroll.
        usdc.transfer(address(placeholder), 10_000e6);
        vm.prank(address(placeholder));
        usdc.approve(address(target), 10_000e6);
        vm.prank(employer);
        eurc.approve(address(target), 1_000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(employer);
        target.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            _recipients2(),
            _amounts(400e6, 500e6),
            1_000e6,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "REENT"
        );
        // The nested call was fully valid (funded, approved, fresh reference,
        // valid recipient) yet failed specifically on the guard...
        assertTrue(placeholder.nestedAttempted(), "nested call attempted");
        assertFalse(placeholder.nestedSucceeded(), "nested call blocked");
        assertEq(bytes4(placeholder.nestedRevertData()), guardSelector, "blocked by ReentrancyGuard");
        // ...while the outer cross-token payroll completed exactly.
        assertEq(usdc.balanceOf(alice), aliceBefore + 400e6, "outer obligation exact");
        assertEq(usdc.balanceOf(bob), bobBefore + 500e6, "outer obligation exact");
    }

    function testCrossPreexistingResidualPreserved() public {
        eurc.transfer(address(payroll), 321);
        usdc.transfer(address(payroll), 654);
        router.configure(900e6);
        uint256 gross = 1_000e6;
        uint256 native = gross * SCALE;
        vm.deal(employer, native);
        vm.prank(employer);
        payroll.executeCrossTokenPayroll{value: native}(
            address(usdc),
            address(eurc),
            _recipients2(),
            _amounts(400e6, 500e6),
            gross,
            900e6,
            MIN_HOP,
            block.timestamp + 5 minutes,
            "PRESRV"
        );
        assertEq(eurc.balanceOf(address(payroll)), 321);
        assertEq(usdc.balanceOf(address(payroll)), 654);
    }

    function testDigestSensitivity() public {
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(10e6, 20e6);
        bytes32 original =
            payroll.canonicalBatchDigest(employer, address(usdc), address(usdc), recipients, amounts, "REF");
        assertNotEq(
            original, payroll.canonicalBatchDigest(bob, address(usdc), address(usdc), recipients, amounts, "REF")
        );
        (recipients[0], recipients[1]) = (recipients[1], recipients[0]);
        assertNotEq(
            original, payroll.canonicalBatchDigest(employer, address(usdc), address(usdc), recipients, amounts, "REF")
        );
        (recipients[0], recipients[1]) = (recipients[1], recipients[0]);
        amounts[0] += 1;
        assertNotEq(
            original, payroll.canonicalBatchDigest(employer, address(usdc), address(usdc), recipients, amounts, "REF")
        );
        amounts[0] -= 1;
        assertNotEq(
            original, payroll.canonicalBatchDigest(employer, address(usdc), address(eurc), recipients, amounts, "REF")
        );
        assertNotEq(
            original, payroll.canonicalBatchDigest(employer, address(usdc), address(usdc), recipients, amounts, "OTHER")
        );
        vm.chainId(block.chainid + 1);
        assertNotEq(
            original, payroll.canonicalBatchDigest(employer, address(usdc), address(usdc), recipients, amounts, "REF")
        );
    }

    function testReferenceHashIsRouteIndependent() public view {
        // Same employer + reference yields one replay key regardless of route.
        bytes32 h = payroll.canonicalReferenceHash(employer, "R");
        assertEq(h, keccak256(abi.encode(block.chainid, address(payroll), employer, "R")));
    }

    // =====================================================================
    // Fuzz (deterministic, high-value bounds, exact-obligation semantics)
    // =====================================================================

    function testFuzz_SameTokenFeeConservation(uint256 a, uint256 b) public {
        a = bound(a, 1e6, 100_000e6);
        b = bound(b, 1e6, 100_000e6);
        uint256 feeA = (a * FEE_BPS) / 10_000;
        uint256 feeB = (b * FEE_BPS) / 10_000;
        uint256 funding = a + b + feeA + feeB;
        string memory ref =
            string.concat("FUZZ-", vm.toString(a), "-", vm.toString(b), "-", vm.toString(block.timestamp));
        usdc.transfer(employer, funding);
        vm.startPrank(employer);
        usdc.approve(address(payroll), funding);
        uint256 payerBefore = usdc.balanceOf(employer);
        uint256 safeBefore = usdc.balanceOf(SAFE);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        address[] memory recipients = _recipients2();
        uint256[] memory amounts = _amounts(a, b);
        uint256 out = payroll.executeSameTokenPayroll(address(usdc), recipients, amounts, ref);
        vm.stopPrank();
        // Exact-obligation conservation: debit is obligations plus fee on top.
        assertEq(out, a + b, "recipients receive exact obligations");
        assertEq(usdc.balanceOf(alice) - aliceBefore, a);
        assertEq(usdc.balanceOf(bob) - bobBefore, b);
        assertEq(payerBefore - usdc.balanceOf(employer), funding);
        assertEq(usdc.balanceOf(SAFE) - safeBefore, feeA + feeB);
        assertEq(usdc.balanceOf(address(payroll)), 0);
    }

    function testFuzz_CrossEurcFeeConservation(uint256 gross) public {
        gross = bound(gross, 2e6, 100_000e6);
        uint256 fee = (gross * FEE_BPS) / 10_000;
        uint256 net = gross - fee;
        router.configure(net * 9 / 10);
        if (eurc.balanceOf(employer) < gross) eurc.transfer(employer, gross);
        vm.startPrank(employer);
        eurc.approve(address(payroll), gross);
        uint256 safeBefore = eurc.balanceOf(SAFE);
        address[] memory recipients = _recipients2();
        uint256 half = (net * 9 / 10) / 2;
        uint256[] memory outputs = _amounts(half, half);
        payroll.executeCrossTokenPayroll(
            address(eurc),
            address(usdc),
            recipients,
            outputs,
            gross,
            half + half,
            MIN_HOP,
            block.timestamp + 5 minutes,
            string.concat("FZX-", vm.toString(gross))
        );
        vm.stopPrank();
        assertEq(eurc.balanceOf(SAFE), safeBefore + fee);
        assertEq(eurc.balanceOf(address(payroll)), 0);
    }

    function testFuzz_BatchDigestOrderSensitive(uint256 x, uint256 y) public view {
        x = bound(x, 1, 1_000_000e6);
        y = bound(y, 1, 1_000_000e6);
        vm.assume(x != y);
        address[] memory r1 = new address[](2);
        r1[0] = alice;
        r1[1] = bob;
        uint256[] memory a1 = new uint256[](2);
        a1[0] = x;
        a1[1] = y;
        address[] memory r2 = new address[](2);
        r2[0] = bob;
        r2[1] = alice;
        uint256[] memory a2 = new uint256[](2);
        a2[0] = y;
        a2[1] = x;
        // Same multiset in different order must hash differently (order bound).
        bytes32 h1 = payroll.canonicalBatchDigest(employer, address(usdc), address(usdc), r1, a1, "F");
        bytes32 h2 = payroll.canonicalBatchDigest(employer, address(usdc), address(usdc), r2, a2, "F");
        assertNotEq(h1, h2);
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    function _findReferenceConsumedDigest(Vm.Log[] memory logs) internal view returns (bytes32 digest) {
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == REF_CONSUMED_SIG) {
                (, bytes32 d,,,,,) =
                    abi.decode(logs[i].data, (address, bytes32, uint256, uint256, uint256, uint256, string));
                digest = d;
                found = true;
            }
        }
        assertTrue(found, "PayrollReferenceConsumed not emitted");
    }

    function _recipients2() internal view returns (address[] memory r) {
        r = new address[](2);
        r[0] = alice;
        r[1] = bob;
    }

    function _singleAddr(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _amounts(uint256 a, uint256 b) internal pure returns (uint256[] memory m) {
        m = new uint256[](2);
        m[0] = a;
        m[1] = b;
    }

    function _single(uint256 a) internal pure returns (uint256[] memory m) {
        m = new uint256[](1);
        m[0] = a;
    }
}
