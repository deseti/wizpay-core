// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title INamespaceRootRegistry
 * @notice Read-only interface exposed to namespace controllers.
 */
interface INamespaceRootRegistry {
    /**
     * @notice Returns the resolver used when registrations request metadata without an explicit resolver.
     * @return resolver The default resolver address.
     */
    function defaultResolver() external view returns (address resolver);

    /**
     * @notice Returns the revenue vault for a namespace.
     * @param namespaceLabelhash The keccak256 hash of the namespace label.
     * @return vault The namespace vault address.
     */
    function namespaceVault(bytes32 namespaceLabelhash) external view returns (address vault);

    /**
     * @notice Returns whether a namespace may currently accept registrations and renewals.
     * @param namespaceLabelhash The keccak256 hash of the namespace label.
     * @return isActive True when the namespace is live and not blacklisted.
     */
    function isNamespaceActive(bytes32 namespaceLabelhash) external view returns (bool isActive);

    /**
     * @notice Returns the effective rent price for a label length and duration under a namespace.
     * @param namespaceLabelhash The keccak256 hash of the namespace label.
     * @param labelLength The validated second-level label length.
     * @param duration The requested registration or renewal duration in seconds.
     * @return price The final price after any active promo discount.
     */
    function rentPrice(bytes32 namespaceLabelhash, uint256 labelLength, uint256 duration)
        external
        view
        returns (uint256 price);
}