// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StableFXBridge} from "src/StableFXBridge.sol";
import {WizPay} from "src/WizPay.sol";
import {StableFXAdapter_V2} from "src/StableFXAdapter_V2.sol";

/**
 * @title DeployStableFXBridge
 * @notice Deploys the StableFXBridge and migrates the Payment_Router (WizPay) to use it.
 * @dev This script performs the full migration sequence:
 *      1. Deploy StableFXBridge with constructor params
 *      2. Update Payment_Router's fxEngine to point to the new bridge
 *      3. Mark migration complete on StableFXAdapter_V2 (prevents future rate updates)
 *
 *      After execution, all FX operations route through StableFXBridge and the
 *      deprecated StableFXAdapter_V2 can no longer accept setExchangeRate calls.
 *
 *      Required env vars:
 *        - PRIVATE_KEY              Deployer/owner private key (with 0x prefix)
 *        - ORCHESTRATOR_ADDRESS     Off-chain orchestrator address for pre-funding swaps
 *        - USDC_ADDRESS             USDC token contract address
 *        - EURC_ADDRESS             EURC token contract address
 *        - WIZPAY_ADDRESS           Deployed WizPay (Payment_Router) contract address
 *        - ADAPTER_V2_ADDRESS       Deployed StableFXAdapter_V2 contract address
 */
contract DeployStableFXBridge is Script {
    function run() external returns (StableFXBridge bridge) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        // Read required addresses from environment
        address orchestrator = vm.envAddress("ORCHESTRATOR_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address eurc = vm.envAddress("EURC_ADDRESS");
        address wizPayAddress = vm.envAddress("WIZPAY_ADDRESS");
        address adapterV2Address = vm.envAddress("ADAPTER_V2_ADDRESS");

        console2.log("=== StableFXBridge Migration ===");
        console2.log("Deployer:", deployer);
        console2.log("Orchestrator:", orchestrator);
        console2.log("USDC:", usdc);
        console2.log("EURC:", eurc);
        console2.log("WizPay (Payment_Router):", wizPayAddress);
        console2.log("StableFXAdapter_V2 (deprecated):", adapterV2Address);

        vm.startBroadcast(deployerPrivateKey);

        // ─── Step 1: Deploy StableFXBridge ────────────────────────────────
        // The bridge implements IFXEngine and acts as a pass-through for the
        // Payment_Router, delegating actual FX execution to the off-chain
        // Circle StableFX RFQ infrastructure via the orchestrator.
        bridge = new StableFXBridge(deployer, orchestrator, usdc, eurc);
        console2.log("StableFXBridge deployed to:", address(bridge));

        // ─── Step 2: Update Payment_Router to use new bridge ──────────────
        // Routes all subsequent swap() calls through StableFXBridge instead
        // of the deprecated StableFXAdapter_V2.
        WizPay wizPay = WizPay(wizPayAddress);
        wizPay.updateFXEngine(address(bridge));
        console2.log("Payment_Router fxEngine updated to StableFXBridge");

        // ─── Step 3: Finalize migration on StableFXAdapter_V2 ─────────────
        // Prevents any future setExchangeRate calls on the deprecated adapter.
        // This is irreversible — the adapter can no longer accept rate updates.
        StableFXAdapter_V2 adapterV2 = StableFXAdapter_V2(adapterV2Address);
        adapterV2.setMigrationComplete();
        console2.log("StableFXAdapter_V2 migration marked complete");

        vm.stopBroadcast();

        console2.log("=== Migration Complete ===");
        console2.log("All FX operations now route through StableFXBridge");
        console2.log("StableFXAdapter_V2 rate updates permanently disabled");
    }
}
