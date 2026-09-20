// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {WizPaySwapExecutorMainnet} from "src/WizPaySwapExecutorMainnet.sol";

/// @notice Fail-closed deployment boundary for WizPaySwapExecutorMainnet.
/// @dev Exact Arc Mainnet resources are pinned here. Actual deployment remains
/// disabled until Step 10 authorization, manifest and verification gates pass.
contract DeployWizPaySwapExecutorMainnet is Script {
    uint256 public constant ARC_MAINNET_CHAIN_ID = 5_042;

    address public constant CANONICAL_USDC = 0x3600000000000000000000000000000000000000;

    address public constant CANONICAL_EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;

    address public constant UNIVERSAL_ROUTER = 0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1;

    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint24 public constant POOL_FEE = 500;
    int24 public constant POOL_TICK_SPACING = 10;

    error MainnetDeploymentDisabled();

    function run() external pure returns (WizPaySwapExecutorMainnet) {
        revert MainnetDeploymentDisabled();
    }

    function creationBytecodeHash() external pure returns (bytes32) {
        return keccak256(type(WizPaySwapExecutorMainnet).creationCode);
    }

    function constructorDigest(address owner, uint256 feeBps) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                owner,
                owner,
                feeBps,
                CANONICAL_USDC,
                CANONICAL_EURC,
                UNIVERSAL_ROUTER,
                PERMIT2,
                POOL_FEE,
                POOL_TICK_SPACING
            )
        );
    }

    function initCodeHash(address owner, uint256 feeBps) external pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(WizPaySwapExecutorMainnet).creationCode,
                abi.encode(
                    owner,
                    owner,
                    feeBps,
                    CANONICAL_USDC,
                    CANONICAL_EURC,
                    UNIVERSAL_ROUTER,
                    PERMIT2,
                    POOL_FEE,
                    POOL_TICK_SPACING
                )
            )
        );
    }
}
