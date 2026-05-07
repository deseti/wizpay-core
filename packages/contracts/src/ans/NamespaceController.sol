// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArcRegistry} from "./ArcRegistry.sol";
import {INamespaceRegistrar} from "./NamespaceRegistrar.sol";
import {IConfigurableResolver} from "./PublicResolver.sol";
import {INamespaceRootRegistry} from "./INamespaceRootRegistry.sol";

/**
 * @title NamespaceController
 * @notice Registration authority scoped to a single namespace.
 * @dev Trust boundary: the controller can only mint and renew beneath its registrar base node and only routes revenue to the vault configured for its namespace.
 */
contract NamespaceController is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_LABEL_LENGTH = 3;

    INamespaceRegistrar public immutable registrar;
    IArcRegistry public immutable registry;
    INamespaceRootRegistry public immutable rootRegistry;
    IERC20 public immutable usdc;
    bytes32 public immutable namespaceLabelhash;

    error InvalidRegistrant(address owner);
    error NamespaceInactive(bytes32 namespaceLabelhash);
    error InvalidNamespaceVault(address vault);
    error LabelTooShort(uint256 length);
    error InvalidLabelCharacter(uint256 index, bytes1 character);
    error InvalidHyphenPlacement();
    error DotsNotAllowed();
    error ResolverRequired();
    error TextRecordArrayLengthMismatch(uint256 keysLength, uint256 valuesLength);
    error NameUnavailable(string label);

    event NameRegistered(
        string label,
        bytes32 indexed labelhash,
        bytes32 indexed node,
        address indexed owner,
        address resolver,
        uint256 pricePaid,
        uint256 expires
    );

    event NameRenewed(string label, bytes32 indexed labelhash, uint256 pricePaid, uint256 expires);

    constructor(
        INamespaceRegistrar registrar_,
        INamespaceRootRegistry rootRegistry_,
        IERC20 usdc_,
        bytes32 namespaceLabelhash_
    ) {
        registrar = registrar_;
        registry = registrar_.registry();
        rootRegistry = rootRegistry_;
        usdc = usdc_;
        namespaceLabelhash = namespaceLabelhash_;
    }

    function available(string calldata label) external view returns (bool isAvailable) {
        _validateLabel(label);
        if (!rootRegistry.isNamespaceActive(namespaceLabelhash)) {
            return false;
        }

        return registrar.available(_tokenIdFor(label));
    }

    function rentPrice(string memory label, uint256 duration) public view returns (uint256 price) {
        uint256 labelLength = _validateLabel(label);
        return rootRegistry.rentPrice(namespaceLabelhash, labelLength, duration);
    }

    function namehash(string calldata label) external view returns (bytes32 node) {
        _validateLabel(label);
        return _nodeFor(label);
    }

    function register(
        string calldata label,
        address ownerAddress,
        uint256 duration,
        address resolverAddress,
        address resolvedAddress,
        string[] calldata textKeys,
        string[] calldata textValues
    ) external nonReentrant returns (bytes32 node, uint256 expires) {
        uint256 labelLength = _validateLabel(label);
        if (ownerAddress == address(0)) {
            revert InvalidRegistrant(address(0));
        }
        if (textKeys.length != textValues.length) {
            revert TextRecordArrayLengthMismatch(textKeys.length, textValues.length);
        }
        if (!rootRegistry.isNamespaceActive(namespaceLabelhash)) {
            revert NamespaceInactive(namespaceLabelhash);
        }

        bytes32 labelhash = keccak256(bytes(label));
        uint256 tokenId = uint256(labelhash);
        if (!registrar.available(tokenId)) {
            revert NameUnavailable(label);
        }

        uint256 price = rootRegistry.rentPrice(namespaceLabelhash, labelLength, duration);
        _collectPayment(price);

        node = _nodeFor(label);

        bool needsResolverSetup = resolverAddress != address(0) || resolvedAddress != address(0) || textKeys.length != 0;
        address effectiveResolver = resolverAddress;
        if (needsResolverSetup && effectiveResolver == address(0)) {
            effectiveResolver = rootRegistry.defaultResolver();
        }

        if (needsResolverSetup) {
            if (effectiveResolver == address(0)) {
                revert ResolverRequired();
            }

            expires = registrar.register(tokenId, address(this), duration);
            registry.setResolver(node, effectiveResolver);

            if (resolvedAddress != address(0)) {
                IConfigurableResolver(effectiveResolver).setAddr(node, resolvedAddress);
            }

            for (uint256 i = 0; i < textKeys.length; ++i) {
                IConfigurableResolver(effectiveResolver).setText(node, textKeys[i], textValues[i]);
            }

            registrar.safeTransferFrom(address(this), ownerAddress, tokenId);
        } else {
            expires = registrar.register(tokenId, ownerAddress, duration);
        }

        emit NameRegistered(label, labelhash, node, ownerAddress, effectiveResolver, price, expires);
    }

    function renew(string calldata label, uint256 duration) external nonReentrant returns (uint256 expires) {
        uint256 labelLength = _validateLabel(label);
        if (!rootRegistry.isNamespaceActive(namespaceLabelhash)) {
            revert NamespaceInactive(namespaceLabelhash);
        }

        uint256 price = rootRegistry.rentPrice(namespaceLabelhash, labelLength, duration);
        _collectPayment(price);

        bytes32 labelhash = keccak256(bytes(label));
        expires = registrar.renew(uint256(labelhash), duration);

        emit NameRenewed(label, labelhash, price, expires);
    }

    function tokenIdForLabel(string calldata label) external pure returns (uint256 tokenId) {
        _validateLabel(label);
        return _tokenIdFor(label);
    }

    function _collectPayment(uint256 amount) internal {
        if (amount == 0) {
            return;
        }

        address vault = rootRegistry.namespaceVault(namespaceLabelhash);
        if (vault == address(0)) {
            revert InvalidNamespaceVault(address(0));
        }

        usdc.safeTransferFrom(msg.sender, vault, amount);
    }

    function _nodeFor(string memory label) internal view returns (bytes32 node) {
        return keccak256(abi.encodePacked(registrar.baseNode(), keccak256(bytes(label))));
    }

    function _tokenIdFor(string memory label) internal pure returns (uint256 tokenId) {
        return uint256(keccak256(bytes(label)));
    }

    function _validateLabel(string memory label) internal pure returns (uint256 labelLength) {
        bytes memory labelBytes = bytes(label);
        labelLength = labelBytes.length;
        if (labelLength < MIN_LABEL_LENGTH) {
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