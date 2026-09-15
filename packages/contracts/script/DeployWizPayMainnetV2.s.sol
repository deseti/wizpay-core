// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {WizPayMainnetV2} from "src/WizPayMainnetV2.sol";

/// @notice Read-only parity helpers for the evidence-backed Mainnet plan.
/// @dev Deployment remains deliberately disabled until real authoritative
/// resource and Safe EIP-1271 authorization records are committed and audited.
contract DeployWizPayMainnetV2 is Script {
    uint256 internal constant ARC_MAINNET_CHAIN_ID = 5042;
    uint256 internal constant PLAN_SCHEMA_VERSION = 3;
    uint256 internal constant DEPLOYMENT_MANIFEST_SCHEMA_VERSION = 2;

    error MainnetDeploymentDisabled();

    function run() external pure returns (WizPayMainnetV2) {
        revert MainnetDeploymentDisabled();
    }

    function creationBytecodeHash() external pure returns (bytes32) {
        return keccak256(type(WizPayMainnetV2).creationCode);
    }

    function initCodeHash(address canonicalUsdc, address owner, address feeRecipient, uint256 feeBps)
        external
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(type(WizPayMainnetV2).creationCode, abi.encode(canonicalUsdc, owner, feeRecipient, feeBps))
        );
    }

    function constructorDigest(address canonicalUsdc, address owner, address feeRecipient, uint256 feeBps)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(canonicalUsdc, owner, feeRecipient, feeBps));
    }

    function computeDeploymentPlanDigest(
        bytes32 sourceCommitDigest,
        bytes32 sourceSetDigest,
        bytes32 compilerSettingsDigest,
        bytes32 creationHash,
        bytes32 runtimeBytecodeHash,
        bytes32 deploymentInitCodeHash,
        bytes32 deploymentConstructorDigest,
        address canonicalUsdc,
        address deployer,
        address owner,
        address feeRecipient,
        uint256 feeBps,
        bytes32 resourceManifestDigest
    ) public pure returns (bytes32) {
        bytes32 identityDigest = keccak256(
            abi.encode(
                PLAN_SCHEMA_VERSION,
                DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
                "arc-mainnet",
                ARC_MAINNET_CHAIN_ID,
                "WizPayMainnetV2"
            )
        );
        return keccak256(
            abi.encode(
                identityDigest,
                sourceCommitDigest,
                sourceSetDigest,
                compilerSettingsDigest,
                creationHash,
                runtimeBytecodeHash,
                deploymentInitCodeHash,
                deploymentConstructorDigest,
                canonicalUsdc,
                deployer,
                owner,
                feeRecipient,
                feeBps,
                resourceManifestDigest
            )
        );
    }
}
