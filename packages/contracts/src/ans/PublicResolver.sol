// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IArcRegistry} from "./ArcRegistry.sol";

/**
 * @title IAddrResolver
 * @notice Resolver profile for EVM address resolution.
 */
interface IAddrResolver {
    /**
     * @notice Returns the configured EVM address for a node.
     * @param node The namehash of the node.
     * @return resolvedAddress The configured address.
     */
    function addr(bytes32 node) external view returns (address resolvedAddress);
}

/**
 * @title ITextResolver
 * @notice Resolver profile for text metadata records.
 */
interface ITextResolver {
    /**
     * @notice Returns a text record value for a node.
     * @param node The namehash of the node.
     * @param key The text record key.
     * @return value The stored text value.
     */
    function text(bytes32 node, string calldata key) external view returns (string memory value);
}

/**
 * @title IConfigurableResolver
 * @notice Mutable resolver interface used by the ANS controllers.
 */
interface IConfigurableResolver is IAddrResolver, ITextResolver {
    /**
     * @notice Sets the EVM address for a node.
     * @param node The namehash of the node.
     * @param resolvedAddress The address to store.
     */
    function setAddr(bytes32 node, address resolvedAddress) external;

    /**
     * @notice Sets a text record for a node.
     * @param node The namehash of the node.
     * @param key The text record key.
     * @param value The text record value.
     */
    function setText(bytes32 node, string calldata key, string calldata value) external;
}

/**
 * @title PublicResolver
 * @notice Public resolver for ANS addr() and text() records.
 * @dev Record versioning allows stale records to be cleared without deleting old storage slots.
 */
contract PublicResolver is ERC165, IConfigurableResolver {
    IArcRegistry public immutable registry;

    mapping(bytes32 node => uint64 version) public recordVersions;
    mapping(bytes32 node => mapping(uint64 version => address resolvedAddress)) private _addresses;
    mapping(bytes32 node => mapping(uint64 version => mapping(string key => string value))) private _textRecords;

    error NotAuthorised(bytes32 node, address caller);

    /**
     * @notice Emitted when an addr() record is updated.
     * @param node The namehash of the node.
     * @param resolvedAddress The updated address value.
     */
    event AddrChanged(bytes32 indexed node, address resolvedAddress);

    /**
     * @notice Emitted when a text() record is updated.
     * @param node The namehash of the node.
     * @param key The text record key.
     * @param value The text record value.
     */
    event TextChanged(bytes32 indexed node, string indexed key, string value);

    /**
     * @notice Emitted when records for a node are logically cleared.
     * @param node The namehash of the node.
     * @param newVersion The new active record version.
     */
    event VersionChanged(bytes32 indexed node, uint64 newVersion);

    /**
     * @notice Creates the public resolver.
     * @param registry_ The ANS registry contract.
     */
    constructor(IArcRegistry registry_) {
        registry = registry_;
    }

    modifier authorised(bytes32 node) {
        if (!isAuthorised(node, msg.sender)) {
            revert NotAuthorised(node, msg.sender);
        }
        _;
    }

    /**
     * @notice Returns whether an account can mutate records for a node.
     * @param node The namehash of the node.
     * @param account The account to check.
     * @return allowed True when the account is the node owner or an approved registry operator.
     */
    function isAuthorised(bytes32 node, address account) public view returns (bool allowed) {
        address nodeOwner = registry.owner(node);
        return nodeOwner != address(0)
            && (nodeOwner == account || registry.isApprovedForAll(nodeOwner, account));
    }

    /**
     * @notice Clears all active records for a node by incrementing its record version.
     * @param node The namehash of the node.
     */
    function clearRecords(bytes32 node) external authorised(node) {
        uint64 newVersion = recordVersions[node] + 1;
        recordVersions[node] = newVersion;
        emit VersionChanged(node, newVersion);
    }

    /**
     * @inheritdoc IConfigurableResolver
     */
    function setAddr(bytes32 node, address resolvedAddress) external authorised(node) {
        _addresses[node][recordVersions[node]] = resolvedAddress;
        emit AddrChanged(node, resolvedAddress);
    }

    /**
     * @inheritdoc IAddrResolver
     */
    function addr(bytes32 node) external view returns (address resolvedAddress) {
        return _addresses[node][recordVersions[node]];
    }

    /**
     * @inheritdoc IConfigurableResolver
     */
    function setText(bytes32 node, string calldata key, string calldata value) external authorised(node) {
        _textRecords[node][recordVersions[node]][key] = value;
        emit TextChanged(node, key, value);
    }

    /**
     * @inheritdoc ITextResolver
     */
    function text(bytes32 node, string calldata key) external view returns (string memory value) {
        return _textRecords[node][recordVersions[node]][key];
    }

    /**
     * @notice Returns the current record version for a node.
     * @param node The namehash of the node.
     * @return version The active resolver record version.
     */
    function recordVersion(bytes32 node) external view returns (uint64 version) {
        return recordVersions[node];
    }

    /**
     * @inheritdoc ERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IAddrResolver).interfaceId || interfaceId == type(ITextResolver).interfaceId
            || interfaceId == type(IConfigurableResolver).interfaceId || super.supportsInterface(interfaceId);
    }
}