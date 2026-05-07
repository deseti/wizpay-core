// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IArcRegistry} from "./ArcRegistry.sol";
import {INamespaceRootRegistry} from "./INamespaceRootRegistry.sol";
import {NamespaceFactory} from "./NamespaceFactory.sol";
import {RevenueVault} from "./RevenueVault.sol";

/**
 * @title RootRegistry
 * @notice Ecosystem governor for the multi-tenant ANS namespace ecosystem.
 * @dev Authority boundary:
 * - the contract owner governs reserved labels, blacklist state, the `.arc` commercial surface, and emergency overrides
 * - each partner namespace receives its own registrar, controller, and revenue vault, creating strict isolation per namespace
 * - namespace owners become sovereign registrar operators after bootstrap and may add custom controllers without affecting peers
 */
contract RootRegistry is Ownable, ReentrancyGuard, INamespaceRootRegistry {
    using SafeERC20 for IERC20;

    uint256 public constant CUSTOM_NAMESPACE_REGISTRATION_FEE = 500e6;
    uint256 public constant MAX_BPS = 10_000;
    uint256 public constant MIN_NAMESPACE_LENGTH = 2;
    uint256 public constant YEAR = 365 days;
    bytes32 public constant ROOT_NODE = bytes32(0);
    bytes32 public constant ARC_LABELHASH = keccak256("arc");
    bytes32 public constant ROOT_LABELHASH = keccak256("root");
    bytes32 public constant ADMIN_LABELHASH = keccak256("admin");
    bytes32 public constant WWW_LABELHASH = keccak256("www");

    struct NamespaceRecord {
        address owner;
        address registrar;
        address controller;
        address vault;
        bool active;
        bool isGlobal;
        bool whitelisted;
        bool blacklisted;
    }

    struct PricingConfig {
        uint256 threeCharacterPrice;
        uint256 fourCharacterPrice;
        uint256 fivePlusCharacterPrice;
    }

    struct PromoConfig {
        bool enabled;
        uint16 discountBps;
        uint64 startsAt;
        uint64 endsAt;
    }

    IArcRegistry public immutable registry;
    IERC20 public immutable usdc;
    NamespaceFactory internal immutable namespaceFactory;

    RevenueVault public platformVault;
    address public defaultResolver;

    mapping(bytes32 labelhash => NamespaceRecord) private _namespaceRecords;
    mapping(bytes32 labelhash => PricingConfig) private _pricingConfigs;
    mapping(bytes32 labelhash => PromoConfig) private _promoConfigs;

    error InvalidPlatformVault(address vault);
    error InvalidResolver(address resolver);
    error InvalidNamespaceOwner(address owner);
    error InvalidNamespaceVault(address vault);
    error InvalidDuration(uint256 duration);
    error InvalidPriceTierOrder(uint256 threeCharacter, uint256 fourCharacter, uint256 fivePlusCharacter);
    error InvalidPromoDiscount(uint256 discountBps);
    error InvalidPromoWindow(uint64 startsAt, uint64 endsAt);
    error NamespaceAlreadyExists(bytes32 labelhash);
    error NamespaceNotFound(bytes32 labelhash);
    error NamespaceReserved(bytes32 labelhash);
    error UnauthorizedNamespaceManager(bytes32 labelhash, address caller);
    error LabelTooShort(uint256 length);
    error InvalidLabelCharacter(uint256 index, bytes1 character);
    error InvalidHyphenPlacement();
    error DotsNotAllowed();

    event NamespaceRegistered(
        string label,
        bytes32 indexed labelhash,
        bytes32 indexed node,
        address indexed namespaceOwner,
        address registrar,
        address controller,
        address vault,
        bool isGlobal,
        uint256 setupFeePaid
    );

    event NamespacePricingUpdated(
        bytes32 indexed labelhash,
        uint256 threeCharacterPrice,
        uint256 fourCharacterPrice,
        uint256 fivePlusCharacterPrice
    );

    event NamespacePromoUpdated(
        bytes32 indexed labelhash,
        bool enabled,
        uint16 discountBps,
        uint64 startsAt,
        uint64 endsAt
    );

    event NamespaceSuspensionUpdated(bytes32 indexed labelhash, bool suspended);
    event NamespaceBlacklistUpdated(bytes32 indexed labelhash, bool blacklisted);
    event NamespaceWhitelistUpdated(bytes32 indexed labelhash, bool whitelisted);
    event NamespaceVaultUpdated(bytes32 indexed labelhash, address indexed previousVault, address indexed newVault);
    event PlatformVaultUpdated(address indexed previousVault, address indexed newVault);
    event DefaultResolverUpdated(address indexed previousResolver, address indexed newResolver);

    constructor(
        IArcRegistry registry_,
        IERC20 usdc_,
        RevenueVault platformVault_,
        address defaultResolver_,
        NamespaceFactory namespaceFactory_,
        address initialOwner
    ) Ownable(initialOwner) {
        registry = registry_;
        usdc = usdc_;
        namespaceFactory = namespaceFactory_;

        _setPlatformVault(platformVault_);
        _setDefaultResolver(defaultResolver_);
    }

    modifier onlyNamespaceManager(bytes32 labelhash) {
        NamespaceRecord memory record = _namespaceRecords[labelhash];
        if (record.owner == address(0)) {
            revert NamespaceNotFound(labelhash);
        }
        if (msg.sender != owner() && msg.sender != record.owner) {
            revert UnauthorizedNamespaceManager(labelhash, msg.sender);
        }
        _;
    }

    function bootstrapArcNamespace(
        address namespaceOwner,
        uint256 threeCharacterPrice,
        uint256 fourCharacterPrice,
        uint256 fivePlusCharacterPrice,
        bool promoEnabled,
        uint16 discountBps,
        uint64 startsAt,
        uint64 endsAt
    ) external onlyOwner returns (address registrarAddress, address controllerAddress) {
        if (namespaceOwner == address(0)) {
            revert InvalidNamespaceOwner(address(0));
        }
        if (_namespaceRecords[ARC_LABELHASH].owner != address(0)) {
            revert NamespaceAlreadyExists(ARC_LABELHASH);
        }

        (registrarAddress, controllerAddress) = namespaceFactory.deployGlobalNamespace("arc", ARC_LABELHASH);

        NamespaceRecord storage record = _namespaceRecords[ARC_LABELHASH];
        record.owner = namespaceOwner;
        record.registrar = registrarAddress;
        record.controller = controllerAddress;
        record.vault = address(platformVault);
        record.active = true;
        record.isGlobal = true;
        record.whitelisted = true;

        _setNamespacePricing(ARC_LABELHASH, threeCharacterPrice, fourCharacterPrice, fivePlusCharacterPrice);
        _setNamespacePromo(ARC_LABELHASH, promoEnabled, discountBps, startsAt, endsAt);

        registry.setSubnodeOwner(ROOT_NODE, ARC_LABELHASH, registrarAddress);
        namespaceFactory.finalizeNamespace(registrarAddress, controllerAddress, namespaceOwner, defaultResolver);

        emit NamespaceRegistered(
            "arc",
            ARC_LABELHASH,
            _nodeFor(ARC_LABELHASH),
            namespaceOwner,
            registrarAddress,
            controllerAddress,
            address(platformVault),
            true,
            0
        );
    }

    function registerNamespace(
        string calldata label,
        address namespaceOwner,
        uint256 threeCharacterPrice,
        uint256 fourCharacterPrice,
        uint256 fivePlusCharacterPrice,
        bool promoEnabled,
        uint16 discountBps,
        uint64 startsAt,
        uint64 endsAt
    ) external nonReentrant returns (address registrarAddress, address controllerAddress, address vaultAddress) {
        if (namespaceOwner == address(0)) {
            revert InvalidNamespaceOwner(address(0));
        }

        bytes32 labelhash = _labelhash(label);
        if (_isReservedCustomNamespace(labelhash)) {
            revert NamespaceReserved(labelhash);
        }
        if (_namespaceRecords[labelhash].owner != address(0)) {
            revert NamespaceAlreadyExists(labelhash);
        }

        usdc.safeTransferFrom(msg.sender, address(platformVault), CUSTOM_NAMESPACE_REGISTRATION_FEE);
        (registrarAddress, controllerAddress, vaultAddress) =
            namespaceFactory.deployCustomNamespace(label, labelhash, namespaceOwner);

        NamespaceRecord storage record = _namespaceRecords[labelhash];
        record.owner = namespaceOwner;
        record.registrar = registrarAddress;
        record.controller = controllerAddress;
        record.vault = vaultAddress;
        record.active = true;

        _setNamespacePricing(labelhash, threeCharacterPrice, fourCharacterPrice, fivePlusCharacterPrice);
        _setNamespacePromo(labelhash, promoEnabled, discountBps, startsAt, endsAt);

        registry.setSubnodeOwner(ROOT_NODE, labelhash, registrarAddress);
        namespaceFactory.finalizeNamespace(registrarAddress, controllerAddress, namespaceOwner, defaultResolver);

        emit NamespaceRegistered(
            label,
            labelhash,
            _nodeFor(labelhash),
            namespaceOwner,
            registrarAddress,
            controllerAddress,
            vaultAddress,
            false,
            CUSTOM_NAMESPACE_REGISTRATION_FEE
        );
    }

    function setNamespacePricing(
        string calldata label,
        uint256 threeCharacterPrice,
        uint256 fourCharacterPrice,
        uint256 fivePlusCharacterPrice
    ) external {
        bytes32 labelhash = _requireNamespace(label);
        if (labelhash == ARC_LABELHASH && msg.sender != owner()) {
            revert UnauthorizedNamespaceManager(labelhash, msg.sender);
        }
        if (labelhash != ARC_LABELHASH && msg.sender != owner() && msg.sender != _namespaceRecords[labelhash].owner) {
            revert UnauthorizedNamespaceManager(labelhash, msg.sender);
        }

        _setNamespacePricing(labelhash, threeCharacterPrice, fourCharacterPrice, fivePlusCharacterPrice);
    }

    function setNamespacePromo(
        string calldata label,
        bool enabled,
        uint16 discountBps,
        uint64 startsAt,
        uint64 endsAt
    ) external {
        bytes32 labelhash = _requireNamespace(label);
        if (labelhash == ARC_LABELHASH && msg.sender != owner()) {
            revert UnauthorizedNamespaceManager(labelhash, msg.sender);
        }
        if (labelhash != ARC_LABELHASH && msg.sender != owner() && msg.sender != _namespaceRecords[labelhash].owner) {
            revert UnauthorizedNamespaceManager(labelhash, msg.sender);
        }

        _setNamespacePromo(labelhash, enabled, discountBps, startsAt, endsAt);
    }

    function setNamespaceActive(string calldata label, bool active) external onlyOwner {
        bytes32 labelhash = _requireNamespace(label);
        _namespaceRecords[labelhash].active = active;
        emit NamespaceSuspensionUpdated(labelhash, !active);
    }

    function setNamespaceWhitelist(string calldata label, bool whitelisted) external onlyOwner {
        bytes32 labelhash = _requireNamespace(label);
        _namespaceRecords[labelhash].whitelisted = whitelisted;
        emit NamespaceWhitelistUpdated(labelhash, whitelisted);
    }

    function setNamespaceBlacklist(string calldata label, bool blacklisted) external onlyOwner {
        bytes32 labelhash = _requireNamespace(label);
        _namespaceRecords[labelhash].blacklisted = blacklisted;
        emit NamespaceBlacklistUpdated(labelhash, blacklisted);
    }

    function setNamespaceVault(string calldata label, address newVault) external onlyNamespaceManager(_labelhash(label)) {
        bytes32 labelhash = _requireNamespace(label);
        if (labelhash == ARC_LABELHASH) {
            revert NamespaceReserved(labelhash);
        }
        if (newVault == address(0)) {
            revert InvalidNamespaceVault(address(0));
        }

        address previousVault = _namespaceRecords[labelhash].vault;
        _namespaceRecords[labelhash].vault = newVault;
        emit NamespaceVaultUpdated(labelhash, previousVault, newVault);
    }

    function setPlatformVault(RevenueVault newPlatformVault) external onlyOwner {
        _setPlatformVault(newPlatformVault);

        if (_namespaceRecords[ARC_LABELHASH].owner != address(0)) {
            address previousVault = _namespaceRecords[ARC_LABELHASH].vault;
            _namespaceRecords[ARC_LABELHASH].vault = address(newPlatformVault);
            emit NamespaceVaultUpdated(ARC_LABELHASH, previousVault, address(newPlatformVault));
        }
    }

    function setDefaultResolver(address newDefaultResolver) external onlyOwner {
        _setDefaultResolver(newDefaultResolver);
    }

    function namespaceVault(bytes32 namespaceLabelhash) external view returns (address vault) {
        return _namespaceRecords[namespaceLabelhash].vault;
    }

    function isNamespaceActive(bytes32 namespaceLabelhash) public view returns (bool isActive) {
        NamespaceRecord memory record = _namespaceRecords[namespaceLabelhash];
        return record.owner != address(0) && record.active && !record.blacklisted;
    }

    function rentPrice(bytes32 namespaceLabelhash, uint256 labelLength, uint256 duration)
        external
        view
        returns (uint256 price)
    {
        NamespaceRecord memory record = _namespaceRecords[namespaceLabelhash];
        if (record.owner == address(0)) {
            revert NamespaceNotFound(namespaceLabelhash);
        }
        if (duration == 0) {
            revert InvalidDuration(duration);
        }

        PricingConfig memory pricing = _pricingConfigs[namespaceLabelhash];
        uint256 annualPrice = _annualPriceForLength(pricing, labelLength);
        uint256 basePrice = Math.mulDiv(annualPrice, duration, YEAR, Math.Rounding.Ceil);

        PromoConfig memory promo = _promoConfigs[namespaceLabelhash];
        if (!_isPromoActive(promo) || promo.discountBps == 0) {
            return basePrice;
        }

        uint256 discount = Math.mulDiv(basePrice, promo.discountBps, MAX_BPS);
        return basePrice - discount;
    }

    function namespaceConfig(string calldata label)
        external
        view
        returns (
            address namespaceOwner,
            address registrar,
            address controller,
            address vault,
            bool active,
            bool isGlobal,
            bool whitelisted,
            bool blacklisted
        )
    {
        bytes32 labelhash = _requireNamespace(label);
        NamespaceRecord memory record = _namespaceRecords[labelhash];
        return (
            record.owner,
            record.registrar,
            record.controller,
            record.vault,
            record.active,
            record.isGlobal,
            record.whitelisted,
            record.blacklisted
        );
    }

    function namespacePricing(string calldata label)
        external
        view
        returns (uint256 threeCharacterPrice, uint256 fourCharacterPrice, uint256 fivePlusCharacterPrice)
    {
        bytes32 labelhash = _requireNamespace(label);
        PricingConfig memory pricing = _pricingConfigs[labelhash];
        return (pricing.threeCharacterPrice, pricing.fourCharacterPrice, pricing.fivePlusCharacterPrice);
    }

    function namespacePromo(string calldata label)
        external
        view
        returns (bool enabled, uint16 discountBps, uint64 startsAt, uint64 endsAt)
    {
        bytes32 labelhash = _requireNamespace(label);
        PromoConfig memory promo = _promoConfigs[labelhash];
        return (promo.enabled, promo.discountBps, promo.startsAt, promo.endsAt);
    }

    function namespaceNode(string calldata label) external pure returns (bytes32 node) {
        return keccak256(abi.encodePacked(ROOT_NODE, keccak256(bytes(label))));
    }

    function _setNamespacePricing(
        bytes32 labelhash,
        uint256 threeCharacterPrice,
        uint256 fourCharacterPrice,
        uint256 fivePlusCharacterPrice
    ) internal {
        if (threeCharacterPrice < fourCharacterPrice || fourCharacterPrice < fivePlusCharacterPrice) {
            revert InvalidPriceTierOrder(threeCharacterPrice, fourCharacterPrice, fivePlusCharacterPrice);
        }

        _pricingConfigs[labelhash] = PricingConfig({
            threeCharacterPrice: threeCharacterPrice,
            fourCharacterPrice: fourCharacterPrice,
            fivePlusCharacterPrice: fivePlusCharacterPrice
        });

        emit NamespacePricingUpdated(labelhash, threeCharacterPrice, fourCharacterPrice, fivePlusCharacterPrice);
    }

    function _setNamespacePromo(bytes32 labelhash, bool enabled, uint16 discountBps, uint64 startsAt, uint64 endsAt)
        internal
    {
        if (discountBps > MAX_BPS) {
            revert InvalidPromoDiscount(discountBps);
        }
        if (enabled && endsAt != 0 && startsAt >= endsAt) {
            revert InvalidPromoWindow(startsAt, endsAt);
        }

        _promoConfigs[labelhash] = PromoConfig({enabled: enabled, discountBps: discountBps, startsAt: startsAt, endsAt: endsAt});
        emit NamespacePromoUpdated(labelhash, enabled, discountBps, startsAt, endsAt);
    }

    function _setPlatformVault(RevenueVault newPlatformVault) internal {
        if (address(newPlatformVault) == address(0)) {
            revert InvalidPlatformVault(address(0));
        }

        address previousVault = address(platformVault);
        platformVault = newPlatformVault;
        emit PlatformVaultUpdated(previousVault, address(newPlatformVault));
    }

    function _setDefaultResolver(address newDefaultResolver) internal {
        if (newDefaultResolver == address(0)) {
            revert InvalidResolver(address(0));
        }

        address previousResolver = defaultResolver;
        defaultResolver = newDefaultResolver;
        emit DefaultResolverUpdated(previousResolver, newDefaultResolver);
    }

    function _annualPriceForLength(PricingConfig memory pricing, uint256 labelLength)
        internal
        pure
        returns (uint256 annualPrice)
    {
        if (labelLength == 3) {
            return pricing.threeCharacterPrice;
        }
        if (labelLength == 4) {
            return pricing.fourCharacterPrice;
        }
        return pricing.fivePlusCharacterPrice;
    }

    function _isPromoActive(PromoConfig memory promo) internal view returns (bool isActive) {
        if (!promo.enabled) {
            return false;
        }
        if (promo.startsAt != 0 && block.timestamp < promo.startsAt) {
            return false;
        }
        if (promo.endsAt != 0 && block.timestamp > promo.endsAt) {
            return false;
        }
        return true;
    }

    function _nodeFor(bytes32 labelhash) internal pure returns (bytes32 node) {
        return keccak256(abi.encodePacked(ROOT_NODE, labelhash));
    }

    function _isReservedCustomNamespace(bytes32 labelhash) internal pure returns (bool isReserved) {
        return labelhash == ARC_LABELHASH || labelhash == ROOT_LABELHASH || labelhash == ADMIN_LABELHASH
            || labelhash == WWW_LABELHASH;
    }

    function _requireNamespace(string memory label) internal view returns (bytes32 labelhash) {
        labelhash = _labelhash(label);
        if (_namespaceRecords[labelhash].owner == address(0)) {
            revert NamespaceNotFound(labelhash);
        }
    }

    function _labelhash(string memory label) internal pure returns (bytes32 labelhash) {
        _validateNamespaceLabel(label);
        return keccak256(bytes(label));
    }

    function _validateNamespaceLabel(string memory label) internal pure returns (uint256 labelLength) {
        bytes memory labelBytes = bytes(label);
        labelLength = labelBytes.length;
        if (labelLength < MIN_NAMESPACE_LENGTH) {
            revert LabelTooShort(labelLength);
        }
        if (labelBytes[0] == 0x2d || labelBytes[labelLength - 1] == 0x2d) {
            revert InvalidHyphenPlacement();
        }

        for (uint256 i = 0; i < labelLength; ++i) {
            bytes1 character = labelBytes[i];
            bool isLowercaseLetter = character >= 0x61 && character <= 0x7a;
            bool isDigit = character >= 0x30 && character <= 0x39;
            bool isHyphen = character == 0x2d;

            if (character == 0x2e) {
                revert DotsNotAllowed();
            }
            if (!isLowercaseLetter && !isDigit && !isHyphen) {
                revert InvalidLabelCharacter(i, character);
            }
        }
    }
}