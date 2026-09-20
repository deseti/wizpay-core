// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployWizPaySwapExecutorMainnet} from "script/DeployWizPaySwapExecutorMainnet.s.sol";
import {WizPaySwapExecutorMainnet} from "src/WizPaySwapExecutorMainnet.sol";

contract DeployWizPaySwapExecutorMainnetTest is Test {
    DeployWizPaySwapExecutorMainnet internal script;

    address internal constant OWNER = 0x12345678901234567890123456789012345689aB;

    function setUp() public {
        script = new DeployWizPaySwapExecutorMainnet();
    }

    function testDeploymentEntryPointFailsClosed() public {
        vm.expectRevert(DeployWizPaySwapExecutorMainnet.MainnetDeploymentDisabled.selector);
        script.run();
    }

    function testCanonicalArcMainnetResourcesArePinned() public view {
        assertEq(script.ARC_MAINNET_CHAIN_ID(), 5_042);

        assertEq(script.CANONICAL_USDC(), 0x3600000000000000000000000000000000000000);

        assertEq(script.CANONICAL_EURC(), 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1);

        assertEq(script.UNIVERSAL_ROUTER(), 0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1);

        assertEq(script.PERMIT2(), 0x000000000022D473030F116dDEE9F6B43aC78BA3);

        assertEq(script.POOL_FEE(), 500);
        assertEq(script.POOL_TICK_SPACING(), 10);
    }

    function testConstructorDigestPinsCanonicalResources() public view {
        uint256 feeBps = 25;

        bytes32 expected = keccak256(
            abi.encode(
                OWNER,
                OWNER,
                feeBps,
                script.CANONICAL_USDC(),
                script.CANONICAL_EURC(),
                script.UNIVERSAL_ROUTER(),
                script.PERMIT2(),
                uint24(500),
                int24(10)
            )
        );

        assertEq(script.constructorDigest(OWNER, feeBps), expected);
    }

    function testInitCodeHashPinsCanonicalResources() public view {
        uint256 feeBps = 25;

        bytes32 expected = keccak256(
            abi.encodePacked(
                type(WizPaySwapExecutorMainnet).creationCode,
                abi.encode(
                    OWNER,
                    OWNER,
                    feeBps,
                    script.CANONICAL_USDC(),
                    script.CANONICAL_EURC(),
                    script.UNIVERSAL_ROUTER(),
                    script.PERMIT2(),
                    uint24(500),
                    int24(10)
                )
            )
        );

        assertEq(script.initCodeHash(OWNER, feeBps), expected);
    }
}
