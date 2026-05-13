// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StableFXAdapter_V2} from "src/StableFXAdapter_V2.sol";

/**
 * @title DeployStableFXAdapterV2
 * @notice Minimal deterministic deployment script for StableFXAdapter_V2.
 * @dev Deploys the contract and nothing else. No operational configuration.
 *      Isolated from the WizPay deployment flow (Deploy.s.sol).
 *
 *      Required env vars:
 *        - PRIVATE_KEY     Deployer private key (with 0x prefix)
 *        - BASE_ASSET      Address of the pool's base accounting token (e.g. USDC)
 *        - INITIAL_OWNER   Address that will own the deployed adapter
 */
contract DeployStableFXAdapterV2 is Script {
    function run() external returns (StableFXAdapter_V2 adapter) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address initialOwner = vm.envAddress("INITIAL_OWNER");
        address baseAsset = vm.envAddress("BASE_ASSET");

        vm.startBroadcast(deployerPrivateKey);

        adapter = new StableFXAdapter_V2(initialOwner, baseAsset);

        vm.stopBroadcast();

        console2.log("=== StableFXAdapter_V2 Deployed ===");
        console2.log("Address:", address(adapter));
        console2.log("Owner:", initialOwner);
        console2.log("Base Asset:", baseAsset);
    }
}
