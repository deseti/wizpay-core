// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArcRegistry} from "./ArcRegistry.sol";
import {INamespaceRootRegistry} from "./INamespaceRootRegistry.sol";
import {NamespaceController} from "./NamespaceController.sol";
import {INamespaceRegistrar, NamespaceRegistrar} from "./NamespaceRegistrar.sol";
import {RevenueVault} from "./RevenueVault.sol";

/**
 * @title NamespaceFactory
 * @notice Deploys and wires sovereign namespace contracts on behalf of RootRegistry.
 * @dev RootRegistry must own this factory so only the active protocol governor can instantiate namespace stacks.
 */
contract NamespaceFactory is Ownable {
    IArcRegistry public immutable registry;
    IERC20 public immutable usdc;

    constructor(IArcRegistry registry_, IERC20 usdc_, address initialOwner) Ownable(initialOwner) {
        registry = registry_;
        usdc = usdc_;
    }

    function deployGlobalNamespace(string calldata label, bytes32 labelhash)
        external
        onlyOwner
        returns (address registrarAddress, address controllerAddress)
    {
        (registrarAddress, controllerAddress,) = _deployNamespaceStack(label, labelhash, false, address(0));
    }

    function deployCustomNamespace(string calldata label, bytes32 labelhash, address namespaceOwner)
        external
        onlyOwner
        returns (address registrarAddress, address controllerAddress, address vaultAddress)
    {
        return _deployNamespaceStack(label, labelhash, true, namespaceOwner);
    }

    function finalizeNamespace(
        address registrarAddress,
        address controllerAddress,
        address namespaceOwner,
        address defaultResolver
    ) external onlyOwner {
        NamespaceRegistrar registrar = NamespaceRegistrar(registrarAddress);
        registrar.setResolver(defaultResolver);
        registrar.addController(controllerAddress);
        registrar.transferOwnership(namespaceOwner);
    }

    function _deployNamespaceStack(string memory label, bytes32 labelhash, bool deployVault, address namespaceOwner)
        internal
        returns (address registrarAddress, address controllerAddress, address vaultAddress)
    {
        NamespaceRegistrar registrar = new NamespaceRegistrar(
            registry,
            _nodeFor(labelhash),
            string.concat("WizPay .", label, " Names"),
            string.concat("NS-", label),
            address(this)
        );
        NamespaceController controller = new NamespaceController(
            INamespaceRegistrar(address(registrar)), INamespaceRootRegistry(msg.sender), usdc, labelhash
        );

        if (deployVault) {
            vaultAddress = address(new RevenueVault(namespaceOwner));
        }

        return (address(registrar), address(controller), vaultAddress);
    }

    function _nodeFor(bytes32 labelhash) internal pure returns (bytes32 node) {
        return keccak256(abi.encodePacked(bytes32(0), labelhash));
    }
}