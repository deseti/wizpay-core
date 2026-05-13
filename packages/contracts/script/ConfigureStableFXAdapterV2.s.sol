// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StableFXAdapter_V2} from "src/StableFXAdapter_V2.sol";

/**
 * @title ConfigureStableFXAdapterV2
 * @notice Post-deployment operational configuration for StableFXAdapter_V2.
 * @dev Separated from deployment to isolate deterministic contract creation
 *      from mutable operational state. Fail-fast on all inputs.
 *
 *      Required env vars:
 *        - PRIVATE_KEY         Owner private key (with 0x prefix)
 *        - ADAPTER_ADDRESS     Deployed StableFXAdapter_V2 address
 *
 *      Token registration (optional, set any subset):
 *        - TOKEN_1             First accepted token address
 *        - TOKEN_2             Second accepted token address
 *        - TOKEN_3             Third accepted token address
 *        - TOKEN_4             Fourth accepted token address
 *
 *      Exchange rate configuration (optional, requires all four):
 *        - RATE_TOKEN_A        First token in exchange-rate pair
 *        - RATE_TOKEN_B        Second token in exchange-rate pair
 *        - RATE_A_TO_B         Rate from A→B (18 decimals)
 *        - RATE_B_TO_A         Rate from B→A (18 decimals)
 */
contract ConfigureStableFXAdapterV2 is Script {
    function run() external {
        uint256 ownerPrivateKey = vm.envUint("PRIVATE_KEY");
        address adapterAddress = vm.envAddress("ADAPTER_ADDRESS");

        StableFXAdapter_V2 adapter = StableFXAdapter_V2(adapterAddress);

        vm.startBroadcast(ownerPrivateKey);

        // ─── Token Registration ───────────────────────────────────────────
        _registerTokenIfSet(adapter, "TOKEN_1");
        _registerTokenIfSet(adapter, "TOKEN_2");
        _registerTokenIfSet(adapter, "TOKEN_3");
        _registerTokenIfSet(adapter, "TOKEN_4");

        // ─── Exchange Rate Configuration ──────────────────────────────────
        address rateTokenA = vm.envOr("RATE_TOKEN_A", address(0));
        address rateTokenB = vm.envOr("RATE_TOKEN_B", address(0));
        uint256 rateAtoB = vm.envOr("RATE_A_TO_B", uint256(0));
        uint256 rateBtoA = vm.envOr("RATE_B_TO_A", uint256(0));

        if (rateTokenA != address(0) || rateTokenB != address(0) || rateAtoB > 0 || rateBtoA > 0) {
            // If any rate var is set, ALL must be set. Fail-fast.
            require(rateTokenA != address(0), "RATE_TOKEN_A required when configuring rates");
            require(rateTokenB != address(0), "RATE_TOKEN_B required when configuring rates");
            require(rateAtoB > 0, "RATE_A_TO_B must be > 0");
            require(rateBtoA > 0, "RATE_B_TO_A must be > 0");

            adapter.setExchangeRate(rateTokenA, rateTokenB, rateAtoB);
            console2.log("Rate set: A -> B:", rateAtoB);

            adapter.setExchangeRate(rateTokenB, rateTokenA, rateBtoA);
            console2.log("Rate set: B -> A:", rateBtoA);
        }

        vm.stopBroadcast();

        console2.log("=== Configuration Complete ===");
    }

    function _registerTokenIfSet(StableFXAdapter_V2 adapter, string memory envKey) internal {
        address token = vm.envOr(envKey, address(0));
        if (token != address(0)) {
            adapter.addAcceptedToken(token);
            console2.log("Accepted token added:", token);
        }
    }
}
