// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {WizPay} from "src/WizPay.sol";

contract Deploy is Script {
    function run() external returns (WizPay wizPay) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address fxEngine = vm.envAddress("FX_ENGINE_ADDRESS");
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(10));
        address feeCollector = vm.envOr("FEE_COLLECTOR", deployer);

        vm.startBroadcast(deployerPrivateKey);
        wizPay = new WizPay(fxEngine, feeCollector, feeBps);
        vm.stopBroadcast();

        console2.log("WizPay deployed to", address(wizPay));
        console2.log("FX engine", fxEngine);
        console2.log("Fee collector", feeCollector);
        console2.log("Fee bps", feeBps);
    }
}
