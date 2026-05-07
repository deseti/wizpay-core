// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcRegistry} from "src/ans/ArcRegistry.sol";
import {NamespaceController} from "src/ans/NamespaceController.sol";
import {NamespaceFactory} from "src/ans/NamespaceFactory.sol";
import {NamespaceRegistrar} from "src/ans/NamespaceRegistrar.sol";
import {PublicResolver} from "src/ans/PublicResolver.sol";
import {RevenueVault} from "src/ans/RevenueVault.sol";
import {RootRegistry} from "src/ans/RootRegistry.sol";
import {MockERC20} from "src/mocks/MockERC20.sol";

contract ANSTest is Test {
    uint256 internal constant THREE_CHARACTER_PRICE = 100e6;
    uint256 internal constant FOUR_CHARACTER_PRICE = 30e6;
    uint256 internal constant FIVE_PLUS_CHARACTER_PRICE = 5e6;
    uint256 internal constant PARTNER_THREE_CHARACTER_PRICE = 60e6;
    uint256 internal constant PARTNER_FOUR_CHARACTER_PRICE = 20e6;
    uint256 internal constant PARTNER_FIVE_PLUS_CHARACTER_PRICE = 10e6;
    uint16 internal constant PARTNER_DISCOUNT_BPS = 2_000;
    uint256 internal constant PARTNER_NAMESPACE_FEE = 500e6;
    uint256 internal constant ONE_YEAR = 365 days;
    uint256 internal constant USER_FUNDS = 20_000e6;

    MockERC20 internal usdc;
    ArcRegistry internal arcRegistry;
    PublicResolver internal publicResolver;
    RootRegistry internal rootRegistry;
    NamespaceRegistrar internal arcRegistrar;
    NamespaceController internal arcController;
    RevenueVault internal platformVault;
    NamespaceFactory internal namespaceFactory;

    address internal alice = makeAddr("alice");
    address internal partnerOwner = makeAddr("partner-owner");
    address internal treasuryRecipient = makeAddr("treasury-recipient");

    function setUp() public {
        _deployAnsSystem();
    }

    function testDeploymentWiringMatchesExpectedMultiTenantSetup() public view {
        bytes32 arcNode = _tldNode("arc");
        (
            address namespaceOwner,
            address registrarAddress,
            address controllerAddress,
            address vault,
            bool active,
            bool isGlobal,
            bool whitelisted,
            bool blacklisted
        ) = rootRegistry.namespaceConfig("arc");

        assertEq(arcRegistry.owner(bytes32(0)), address(this));
        assertEq(arcRegistry.owner(arcNode), address(arcRegistrar));
        assertEq(arcRegistry.resolver(arcNode), address(publicResolver));
        assertEq(namespaceOwner, address(this));
        assertEq(registrarAddress, address(arcRegistrar));
        assertEq(controllerAddress, address(arcController));
        assertEq(vault, address(platformVault));
        assertTrue(active);
        assertTrue(isGlobal);
        assertTrue(whitelisted);
        assertFalse(blacklisted);
        assertEq(arcRegistrar.owner(), address(this));
        assertTrue(arcRegistrar.controllers(address(arcController)));
    }

    function testArcRegistrationSendsRevenueToPlatformVault() public {
        string memory label = "alice";
        uint256 startTime = block.timestamp;
        uint256 price = arcController.rentPrice(label, ONE_YEAR);
        (string[] memory textKeys, string[] memory textValues) = _singleTextRecord("email", "alice@arc.test");

        vm.startPrank(alice);
        usdc.approve(address(arcController), price);
        (bytes32 node, uint256 expires) = arcController.register(
            label,
            alice,
            ONE_YEAR,
            address(0),
            alice,
            textKeys,
            textValues
        );
        vm.stopPrank();

        uint256 tokenId = arcController.tokenIdForLabel(label);

        assertEq(node, arcController.namehash(label));
        assertEq(expires, startTime + ONE_YEAR);
        assertEq(arcRegistrar.ownerOf(tokenId), alice);
        assertEq(arcRegistry.owner(node), alice);
        assertEq(arcRegistry.resolver(node), address(publicResolver));
        assertEq(publicResolver.addr(node), alice);
        assertEq(publicResolver.text(node, "email"), "alice@arc.test");
        assertEq(usdc.balanceOf(address(platformVault)), price);
    }

    function testPublicResolverOwnerCanClearRecords() public {
        (bytes32 node,,) = _registerArcName("clearme", alice, alice, "url", "https://alice.arc");

        vm.prank(alice);
        publicResolver.clearRecords(node);

        assertEq(publicResolver.recordVersions(node), 1);
        assertEq(publicResolver.addr(node), address(0));
        assertEq(publicResolver.text(node, "url"), "");
    }

    function testPartnerNamespaceCreationDeploysDedicatedContractsAndChargesFee() public {
        uint256 platformBalanceBefore = usdc.balanceOf(address(platformVault));

        vm.startPrank(partnerOwner);
        usdc.approve(address(rootRegistry), PARTNER_NAMESPACE_FEE);
        (address registrarAddress, address controllerAddress, address vaultAddress) = rootRegistry.registerNamespace(
            "usdc",
            partnerOwner,
            PARTNER_THREE_CHARACTER_PRICE,
            PARTNER_FOUR_CHARACTER_PRICE,
            PARTNER_FIVE_PLUS_CHARACTER_PRICE,
            false,
            0,
            0,
            0
        );
        vm.stopPrank();

        NamespaceRegistrar partnerRegistrar = NamespaceRegistrar(registrarAddress);
        bytes32 usdcNode = _tldNode("usdc");
        (
            address namespaceOwner,
            address storedRegistrar,
            address storedController,
            address storedVault,
            bool active,
            bool isGlobal,
            bool whitelisted,
            bool blacklisted
        ) = rootRegistry.namespaceConfig("usdc");

        assertEq(namespaceOwner, partnerOwner);
        assertEq(storedRegistrar, registrarAddress);
        assertEq(storedController, controllerAddress);
        assertEq(storedVault, vaultAddress);
        assertTrue(active);
        assertFalse(isGlobal);
        assertFalse(whitelisted);
        assertFalse(blacklisted);
        assertEq(arcRegistry.owner(usdcNode), registrarAddress);
        assertEq(arcRegistry.resolver(usdcNode), address(publicResolver));
        assertEq(partnerRegistrar.owner(), partnerOwner);
        assertTrue(partnerRegistrar.controllers(controllerAddress));
        assertEq(usdc.balanceOf(address(platformVault)), platformBalanceBefore + PARTNER_NAMESPACE_FEE);
    }

    function testPartnerDomainRevenueGoesToPartnerVaultAndPromoApplies() public {
        (, address controllerAddress, address vaultAddress) = _registerPartnerNamespace(true, PARTNER_DISCOUNT_BPS);
        NamespaceController partnerController = NamespaceController(controllerAddress);
        string memory label = "alice";
        uint256 price = partnerController.rentPrice(label, ONE_YEAR);
        (string[] memory textKeys, string[] memory textValues) = _singleTextRecord("url", "https://alice.usdc");

        vm.startPrank(alice);
        usdc.approve(address(partnerController), price);
        (bytes32 node, uint256 expires) = partnerController.register(
            label,
            alice,
            ONE_YEAR,
            address(0),
            alice,
            textKeys,
            textValues
        );
        vm.stopPrank();

        assertEq(price, 8e6);
        assertEq(expires, block.timestamp + ONE_YEAR);
        assertEq(arcRegistry.owner(node), alice);
        assertEq(arcRegistry.resolver(node), address(publicResolver));
        assertEq(publicResolver.addr(node), alice);
        assertEq(publicResolver.text(node, "url"), "https://alice.usdc");
        assertEq(usdc.balanceOf(vaultAddress), price);
    }

    function testReservedNamespacesCannotBeRegistered() public {
        bytes32 rootLabelhash = keccak256(bytes("root"));

        vm.startPrank(partnerOwner);
        usdc.approve(address(rootRegistry), PARTNER_NAMESPACE_FEE);
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.NamespaceReserved.selector, rootLabelhash));
        rootRegistry.registerNamespace(
            "root",
            partnerOwner,
            PARTNER_THREE_CHARACTER_PRICE,
            PARTNER_FOUR_CHARACTER_PRICE,
            PARTNER_FIVE_PLUS_CHARACTER_PRICE,
            false,
            0,
            0,
            0
        );
        vm.stopPrank();
    }

    function testAdminCanSuspendPartnerNamespaceAndBlockRegistrations() public {
        (, address controllerAddress,) = _registerPartnerNamespace(false, 0);
        NamespaceController partnerController = NamespaceController(controllerAddress);

        rootRegistry.setNamespaceActive("usdc", false);

        uint256 price = partnerController.rentPrice("alice", ONE_YEAR);
        vm.startPrank(alice);
        usdc.approve(address(partnerController), price);
        vm.expectRevert(abi.encodeWithSelector(NamespaceController.NamespaceInactive.selector, keccak256(bytes("usdc"))));
        partnerController.register(
            "alice",
            alice,
            ONE_YEAR,
            address(0),
            address(0),
            new string[](0),
            new string[](0)
        );
        vm.stopPrank();
    }

    function testPartnerOwnerCanUpdatePricingAndPromoThroughRootRegistry() public {
        _registerPartnerNamespace(false, 0);

        vm.startPrank(partnerOwner);
        rootRegistry.setNamespacePricing("usdc", 90e6, 40e6, 12e6);
        rootRegistry.setNamespacePromo("usdc", true, 2_500, 0, 0);
        vm.stopPrank();

        (uint256 threeCharacterPrice, uint256 fourCharacterPrice, uint256 fivePlusCharacterPrice) =
            rootRegistry.namespacePricing("usdc");
        (bool enabled, uint16 discountBps,,) = rootRegistry.namespacePromo("usdc");

        assertEq(threeCharacterPrice, 90e6);
        assertEq(fourCharacterPrice, 40e6);
        assertEq(fivePlusCharacterPrice, 12e6);
        assertTrue(enabled);
        assertEq(discountBps, 2_500);
    }

    function testPartnerOwnerMayAddCustomNamespaceControllers() public {
        (address registrarAddress,,) = _registerPartnerNamespace(false, 0);
        NamespaceRegistrar partnerRegistrar = NamespaceRegistrar(registrarAddress);
        address customController = makeAddr("custom-controller");

        vm.prank(partnerOwner);
        partnerRegistrar.addController(customController);

        assertTrue(partnerRegistrar.controllers(customController));
    }

    function testPartnerOwnerMayRotateNamespaceVault() public {
        (, address controllerAddress,) = _registerPartnerNamespace(false, 0);
        NamespaceController partnerController = NamespaceController(controllerAddress);
        RevenueVault replacementVault = new RevenueVault(partnerOwner);
        uint256 price = partnerController.rentPrice("alice", ONE_YEAR);

        vm.prank(partnerOwner);
        rootRegistry.setNamespaceVault("usdc", address(replacementVault));

        vm.startPrank(alice);
        usdc.approve(address(partnerController), price);
        partnerController.register(
            "alice",
            alice,
            ONE_YEAR,
            address(0),
            address(0),
            new string[](0),
            new string[](0)
        );
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(replacementVault)), price);
    }

    function testPlatformVaultWithdrawStillWorks() public {
        uint256 price = arcController.rentPrice("alice", ONE_YEAR);

        vm.startPrank(alice);
        usdc.approve(address(arcController), price);
        arcController.register(
            "alice",
            alice,
            ONE_YEAR,
            address(0),
            address(0),
            new string[](0),
            new string[](0)
        );
        vm.stopPrank();

        platformVault.withdraw(address(usdc), treasuryRecipient, price);

        assertEq(usdc.balanceOf(treasuryRecipient), price);
        assertEq(usdc.balanceOf(address(platformVault)), 0);
    }

    function _deployAnsSystem() internal {
        usdc = new MockERC20("Mock USD Coin", "USDC", 6, 1_000_000e6);
        usdc.mint(alice, USER_FUNDS);
        usdc.mint(partnerOwner, USER_FUNDS);

        platformVault = new RevenueVault(address(this));
        arcRegistry = new ArcRegistry(address(this));
        publicResolver = new PublicResolver(arcRegistry);
        namespaceFactory = new NamespaceFactory(arcRegistry, IERC20(address(usdc)), address(this));
        rootRegistry = new RootRegistry(
            arcRegistry,
            IERC20(address(usdc)),
            platformVault,
            address(publicResolver),
            namespaceFactory,
            address(this)
        );

        namespaceFactory.transferOwnership(address(rootRegistry));
        arcRegistry.setApprovalForAll(address(rootRegistry), true);

        (address registrarAddress, address controllerAddress) = rootRegistry.bootstrapArcNamespace(
            address(this),
            THREE_CHARACTER_PRICE,
            FOUR_CHARACTER_PRICE,
            FIVE_PLUS_CHARACTER_PRICE,
            false,
            0,
            0,
            0
        );

        arcRegistrar = NamespaceRegistrar(registrarAddress);
        arcController = NamespaceController(controllerAddress);
    }

    function _registerArcName(
        string memory label,
        address ownerAddress,
        address resolvedAddress,
        string memory textKey,
        string memory textValue
    ) internal returns (bytes32 node, uint256 expires, uint256 price) {
        (string[] memory textKeys, string[] memory textValues) = _singleTextRecord(textKey, textValue);
        price = arcController.rentPrice(label, ONE_YEAR);

        vm.startPrank(ownerAddress);
        usdc.approve(address(arcController), price);
        (node, expires) = arcController.register(
            label,
            ownerAddress,
            ONE_YEAR,
            address(0),
            resolvedAddress,
            textKeys,
            textValues
        );
        vm.stopPrank();
    }

    function _registerPartnerNamespace(bool promoEnabled, uint16 discountBps)
        internal
        returns (address registrarAddress, address controllerAddress, address vaultAddress)
    {
        vm.startPrank(partnerOwner);
        usdc.approve(address(rootRegistry), PARTNER_NAMESPACE_FEE);
        (registrarAddress, controllerAddress, vaultAddress) = rootRegistry.registerNamespace(
            "usdc",
            partnerOwner,
            PARTNER_THREE_CHARACTER_PRICE,
            PARTNER_FOUR_CHARACTER_PRICE,
            PARTNER_FIVE_PLUS_CHARACTER_PRICE,
            promoEnabled,
            discountBps,
            0,
            0
        );
        vm.stopPrank();
    }

    function _singleTextRecord(string memory key, string memory value)
        internal
        pure
        returns (string[] memory keys, string[] memory values)
    {
        keys = new string[](1);
        values = new string[](1);
        keys[0] = key;
        values[0] = value;
    }

    function _tldNode(string memory label) internal pure returns (bytes32 node) {
        return keccak256(abi.encodePacked(bytes32(0), keccak256(bytes(label))));
    }
}