// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IArcRegistry
 * @notice EIP-137 compatible registry interface for Arc Name Service records.
 */
interface IArcRegistry {
    /**
     * @notice Emitted when ownership of an existing node changes.
     * @param node The namehash of the node that changed ownership.
     * @param owner The new owner address.
     */
    event Transfer(bytes32 indexed node, address owner);

    /**
     * @notice Emitted when a subnode owner is assigned.
     * @param node The parent node.
     * @param label The keccak256 label hash of the subnode.
     * @param owner The new subnode owner.
     */
    event NewOwner(bytes32 indexed node, bytes32 indexed label, address owner);

    /**
     * @notice Emitted when a resolver is set for a node.
     * @param node The namehash of the node.
     * @param resolver The resolver contract address.
     */
    event NewResolver(bytes32 indexed node, address resolver);

    /**
     * @notice Emitted when a TTL value is updated for a node.
     * @param node The namehash of the node.
     * @param ttl The new TTL in seconds.
     */
    event NewTTL(bytes32 indexed node, uint64 ttl);

    /**
     * @notice Emitted when an operator approval is updated.
     * @param owner The owner granting or revoking approval.
     * @param operator The operator address.
     * @param approved Whether approval was granted.
     */
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /**
     * @notice Sets the full record for a node.
     * @param node The namehash of the node.
     * @param owner The new owner.
     * @param resolver The resolver address.
     * @param ttl The TTL in seconds.
     */
    function setRecord(bytes32 node, address owner, address resolver, uint64 ttl) external;

    /**
     * @notice Sets the full record for a subnode under a parent node.
     * @param node The parent node.
     * @param label The keccak256 label hash of the subnode.
     * @param owner The new owner.
     * @param resolver The resolver address.
     * @param ttl The TTL in seconds.
     */
    function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl) external;

    /**
     * @notice Sets the owner of a subnode.
     * @param node The parent node.
     * @param label The keccak256 label hash of the subnode.
     * @param owner The new owner.
     * @return subnode The computed namehash of the subnode.
     */
    function setSubnodeOwner(bytes32 node, bytes32 label, address owner) external returns (bytes32 subnode);

    /**
     * @notice Sets the resolver for a node.
     * @param node The namehash of the node.
     * @param resolver The resolver address.
     */
    function setResolver(bytes32 node, address resolver) external;

    /**
     * @notice Sets the owner for a node.
     * @param node The namehash of the node.
     * @param owner The new owner.
     */
    function setOwner(bytes32 node, address owner) external;

    /**
     * @notice Sets the TTL for a node.
     * @param node The namehash of the node.
     * @param ttl The new TTL in seconds.
     */
    function setTTL(bytes32 node, uint64 ttl) external;

    /**
     * @notice Grants or revokes approval for an operator across all nodes owned by the caller.
     * @param operator The operator address.
     * @param approved Whether approval is granted.
     */
    function setApprovalForAll(address operator, bool approved) external;

    /**
     * @notice Returns the current owner for a node.
     * @param node The namehash of the node.
     * @return ownerAddress The current owner address.
     */
    function owner(bytes32 node) external view returns (address ownerAddress);

    /**
     * @notice Returns the resolver configured for a node.
     * @param node The namehash of the node.
     * @return resolverAddress The resolver contract address.
     */
    function resolver(bytes32 node) external view returns (address resolverAddress);

    /**
     * @notice Returns the TTL configured for a node.
     * @param node The namehash of the node.
     * @return ttlValue The TTL in seconds.
     */
    function ttl(bytes32 node) external view returns (uint64 ttlValue);

    /**
     * @notice Returns whether a node record currently exists.
     * @param node The namehash of the node.
     * @return exists True when the node has a non-zero owner.
     */
    function recordExists(bytes32 node) external view returns (bool exists);

    /**
     * @notice Returns whether an operator is approved to manage all nodes of an owner.
     * @param ownerAddress The owner address.
     * @param operator The operator address.
     * @return approved True when the operator is approved.
     */
    function isApprovedForAll(address ownerAddress, address operator) external view returns (bool approved);
}

/**
 * @title ArcRegistry
 * @notice Core EIP-137 compatible registry for Arc Name Service namehash records.
 * @dev The zero node represents the root. The constructor assigns the initial root owner.
 */
contract ArcRegistry is IArcRegistry {
    struct Record {
        address owner;
        address resolver;
        uint64 ttl;
    }

    mapping(bytes32 node => Record) private _records;
    mapping(address ownerAddress => mapping(address operator => bool)) private _operators;

    error InvalidOwner(address owner);
    error InvalidOperator(address operator);
    error NotAuthorised(bytes32 node, address caller);

    /**
     * @notice Creates the registry and assigns the root node to the initial owner.
     * @param initialOwner The owner of the root node.
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert InvalidOwner(address(0));
        }

        _records[bytes32(0)].owner = initialOwner;
        emit Transfer(bytes32(0), initialOwner);
    }

    modifier authorised(bytes32 node) {
        _checkAuthorised(node, msg.sender);
        _;
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function setRecord(bytes32 node, address ownerAddress, address resolverAddress, uint64 ttlValue)
        external
        authorised(node)
    {
        _setOwner(node, ownerAddress);
        _setResolver(node, resolverAddress);
        _setTTL(node, ttlValue);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function setSubnodeRecord(bytes32 node, bytes32 label, address ownerAddress, address resolverAddress, uint64 ttlValue)
        external
        authorised(node)
    {
        bytes32 subnode = _setSubnodeOwner(node, label, ownerAddress);
        _setResolver(subnode, resolverAddress);
        _setTTL(subnode, ttlValue);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function setSubnodeOwner(bytes32 node, bytes32 label, address ownerAddress)
        external
        authorised(node)
        returns (bytes32 subnode)
    {
        return _setSubnodeOwner(node, label, ownerAddress);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function setResolver(bytes32 node, address resolverAddress) external authorised(node) {
        _setResolver(node, resolverAddress);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function setOwner(bytes32 node, address ownerAddress) external authorised(node) {
        _setOwner(node, ownerAddress);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function setTTL(bytes32 node, uint64 ttlValue) external authorised(node) {
        _setTTL(node, ttlValue);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) {
            revert InvalidOperator(operator);
        }

        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function owner(bytes32 node) external view returns (address ownerAddress) {
        return _records[node].owner;
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function resolver(bytes32 node) external view returns (address resolverAddress) {
        return _records[node].resolver;
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function ttl(bytes32 node) external view returns (uint64 ttlValue) {
        return _records[node].ttl;
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function recordExists(bytes32 node) external view returns (bool exists) {
        return _records[node].owner != address(0);
    }

    /**
     * @inheritdoc IArcRegistry
     */
    function isApprovedForAll(address ownerAddress, address operator) external view returns (bool approved) {
        return _operators[ownerAddress][operator];
    }

    /**
     * @notice Returns the complete record for a node.
     * @param node The namehash of the node.
     * @return ownerAddress The node owner.
     * @return resolverAddress The node resolver.
     * @return ttlValue The node TTL.
     */
    function record(bytes32 node) external view returns (address ownerAddress, address resolverAddress, uint64 ttlValue) {
        Record memory entry = _records[node];
        return (entry.owner, entry.resolver, entry.ttl);
    }

    function _setOwner(bytes32 node, address ownerAddress) internal {
        _records[node].owner = ownerAddress;
        emit Transfer(node, ownerAddress);
    }

    function _setResolver(bytes32 node, address resolverAddress) internal {
        _records[node].resolver = resolverAddress;
        emit NewResolver(node, resolverAddress);
    }

    function _setTTL(bytes32 node, uint64 ttlValue) internal {
        _records[node].ttl = ttlValue;
        emit NewTTL(node, ttlValue);
    }

    function _setSubnodeOwner(bytes32 node, bytes32 label, address ownerAddress) internal returns (bytes32 subnode) {
        subnode = keccak256(abi.encodePacked(node, label));
        _records[subnode].owner = ownerAddress;
        emit NewOwner(node, label, ownerAddress);
        emit Transfer(subnode, ownerAddress);
    }

    function _checkAuthorised(bytes32 node, address caller) internal view {
        address nodeOwner = _records[node].owner;
        if (nodeOwner != caller && !_operators[nodeOwner][caller]) {
            revert NotAuthorised(node, caller);
        }
    }
}