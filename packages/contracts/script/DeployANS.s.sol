// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ArcRegistry} from "src/ans/ArcRegistry.sol";
import {NamespaceFactory} from "src/ans/NamespaceFactory.sol";
import {PublicResolver} from "src/ans/PublicResolver.sol";
import {RevenueVault} from "src/ans/RevenueVault.sol";
import {RootRegistry} from "src/ans/RootRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployANS is Script {
    uint256 internal constant THREE_CHARACTER_PRICE = 100e6;
    uint256 internal constant FOUR_CHARACTER_PRICE = 30e6;
    uint256 internal constant FIVE_PLUS_CHARACTER_PRICE = 5e6;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address usdc = vm.envAddress("ARC_USDC");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        RevenueVault platformVault = new RevenueVault(deployer);
        ArcRegistry arcRegistry = new ArcRegistry(deployer);
        PublicResolver publicResolver = new PublicResolver(arcRegistry);
        NamespaceFactory namespaceFactory = new NamespaceFactory(arcRegistry, IERC20(usdc), deployer);
        RootRegistry rootRegistry = new RootRegistry(
            arcRegistry,
            IERC20(usdc),
            platformVault,
            address(publicResolver),
            namespaceFactory,
            deployer
        );

        namespaceFactory.transferOwnership(address(rootRegistry));
        arcRegistry.setApprovalForAll(address(rootRegistry), true);

        (address arcRegistrarAddress, address arcControllerAddress) = rootRegistry.bootstrapArcNamespace(
            deployer,
            THREE_CHARACTER_PRICE,
            FOUR_CHARACTER_PRICE,
            FIVE_PLUS_CHARACTER_PRICE,
            false,
            0,
            0,
            0
        );

        vm.stopBroadcast();

        console.log("PlatformRevenueVault:", address(platformVault));
        console.log("ArcRegistry:", address(arcRegistry));
        console.log("PublicResolver:", address(publicResolver));
        console.log("NamespaceFactory:", address(namespaceFactory));
        console.log("RootRegistry:", address(rootRegistry));
        console.log("ArcNamespaceRegistrar:", arcRegistrarAddress);
        console.log("ArcNamespaceController:", arcControllerAddress);
    }
}