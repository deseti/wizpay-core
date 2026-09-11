// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {WizPayMainnetV2} from "src/WizPayMainnetV2.sol";

/// @notice Phase 8 deployment boundary. Phase 6 must not execute this script.
contract DeployWizPayMainnetV2 is Script {
    uint256 internal constant ARC_MAINNET_CHAIN_ID = 5042;
    uint256 internal constant MAX_FEE_BPS = 100;
    bytes32 internal constant SAFE_AUTHORIZATION = keccak256("PROJECT_OWNER_APPROVED_MAINNET_SAFE");
    bytes32 internal constant FEE_AUTHORIZATION = keccak256("PROJECT_OWNER_APPROVED_FEE_CONFIGURATION");

    error InvalidMainnetDeploymentInput(string field);
    error ArcTestnetResourceRejected(address resource);

    function run() external returns (WizPayMainnetV2 deployed) {
        if (block.chainid != ARC_MAINNET_CHAIN_ID || vm.envUint("MAINNET_CHAIN_ID") != ARC_MAINNET_CHAIN_ID) {
            revert InvalidMainnetDeploymentInput("chainId");
        }
        address canonicalUsdc = vm.envAddress("MAINNET_CANONICAL_USDC");
        address safeOwner = vm.envAddress("MAINNET_SAFE_OWNER");
        address feeRecipient = vm.envAddress("MAINNET_AUTHORIZED_FEE_RECIPIENT");
        uint256 feeBps = vm.envUint("MAINNET_APPROVED_FEE_BPS");
        uint256 deployerKey = vm.envUint("MAINNET_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        bytes32 constructorDigest = keccak256(abi.encode(canonicalUsdc, safeOwner, feeRecipient, feeBps));
        bytes32 planDigest = vm.envBytes32("MAINNET_DEPLOYMENT_PLAN_DIGEST");
        string memory sourceCommit = vm.envString("MAINNET_SOURCE_COMMIT");

        _validateAddress(canonicalUsdc, "canonicalUsdc");
        _validateAddress(safeOwner, "safeOwner");
        _validateAddress(feeRecipient, "feeRecipient");
        _validateAddress(deployer, "deployer");
        if (safeOwner == deployer) revert InvalidMainnetDeploymentInput("safeOwner must not equal deployer");
        if (feeBps > MAX_FEE_BPS) revert InvalidMainnetDeploymentInput("feeBps");
        if (planDigest == bytes32(0)) revert InvalidMainnetDeploymentInput("planDigest");
        if (bytes(sourceCommit).length != 40) revert InvalidMainnetDeploymentInput("sourceCommit");
        if (keccak256(bytes(vm.envString("MAINNET_SAFE_OWNER_AUTHORIZATION"))) != SAFE_AUTHORIZATION) {
            revert InvalidMainnetDeploymentInput("safeOwnerAuthorization");
        }
        if (keccak256(bytes(vm.envString("MAINNET_FEE_CONFIGURATION_AUTHORIZATION"))) != FEE_AUTHORIZATION) {
            revert InvalidMainnetDeploymentInput("feeConfigurationAuthorization");
        }
        if (vm.envBytes32("MAINNET_CONSTRUCTOR_DIGEST") != constructorDigest) {
            revert InvalidMainnetDeploymentInput("constructorDigest");
        }

        vm.startBroadcast(deployerKey);
        deployed = new WizPayMainnetV2(canonicalUsdc, safeOwner, feeRecipient, feeBps);
        vm.stopBroadcast();
        if (deployed.owner() != safeOwner) revert InvalidMainnetDeploymentInput("deployedOwner");
    }

    function _validateAddress(address value, string memory field) private pure {
        if (value == address(0)) revert InvalidMainnetDeploymentInput(field);
        if (_isKnownTestnet(value)) revert ArcTestnetResourceRejected(value);
    }

    function _isKnownTestnet(address value) private pure returns (bool) {
        return value == 0x32F251fc36A1174901124589EAC2d4E391816F69
            || value == 0xE89f7c3781Dd24baE53d6ef9Af8a6a174731b4c8
            || value == 0x87ACE45582f45cC81AC1E627E875AE84cbd75946
            || value == 0xCbaf97B317A9cAAAE27c3d8deD48d845C4064C32
            || value == 0x3600000000000000000000000000000000000000
            || value == 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
            || value == 0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C
            || value == 0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed
            || value == 0xAA557eb00063ad487BFe0304Bd04B4d45114b721
            || value == 0x73742278c31a76dBb0D2587d03ef92E6E2141023;
    }
}
