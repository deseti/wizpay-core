// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {WizPaySwapExecutorV2} from "src/WizPaySwapExecutorV2.sol";

/**
 * @notice Deployment-only script. Router and token allowlists must be applied
 *         later through Safe transactions; this script performs no deployment
 *         unless explicitly run with --broadcast.
 */
contract DeployWizPaySwapExecutorV2 is Script {
    uint256 internal constant FEE_BPS = 25;

    function run() external returns (WizPaySwapExecutorV2 executor) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address safe = vm.envAddress("WIZPAY_FEE_SAFE");

        vm.startBroadcast(deployerPrivateKey);
        executor = new WizPaySwapExecutorV2(safe, safe, FEE_BPS);
        vm.stopBroadcast();

        console2.log("WizPaySwapExecutorV2:", address(executor));
        console2.log("Owner and immutable fee recipient:", safe);
        console2.log("Fee bps:", FEE_BPS);
    }
}
