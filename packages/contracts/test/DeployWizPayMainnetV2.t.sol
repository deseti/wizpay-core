// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployWizPayMainnetV2} from "script/DeployWizPayMainnetV2.s.sol";
import {WizPayMainnetV2} from "src/WizPayMainnetV2.sol";

contract DeployWizPayMainnetV2Test is Test {
    DeployWizPayMainnetV2 internal script;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant OWNER = 0x12345678901234567890123456789012345689aB;
    address internal constant FEE = 0x1234567890123456789012345678901234569abC;

    function setUp() public {
        script = new DeployWizPayMainnetV2();
    }

    function testDeploymentEntryPointFailsClosed() public {
        vm.expectRevert(DeployWizPayMainnetV2.MainnetDeploymentDisabled.selector);
        script.run();
    }

    function testRecomputesCreationConstructorAndInitCode() public view {
        assertEq(script.creationBytecodeHash(), keccak256(type(WizPayMainnetV2).creationCode));
        assertEq(script.constructorDigest(USDC, OWNER, FEE, 10), keccak256(abi.encode(USDC, OWNER, FEE, uint256(10))));
        assertEq(
            script.initCodeHash(USDC, OWNER, FEE, 10),
            keccak256(abi.encodePacked(type(WizPayMainnetV2).creationCode, abi.encode(USDC, OWNER, FEE, uint256(10))))
        );
    }

    function testEveryReadablePlanFieldMutatesDigest() public view {
        bytes32 baseline = _digest(keccak256("source"), keccak256("sources"), 10);
        assertNotEq(_digest(keccak256("changed"), keccak256("sources"), 10), baseline);
        assertNotEq(_digest(keccak256("source"), keccak256("changed"), 10), baseline);
        assertNotEq(_digest(keccak256("source"), keccak256("sources"), 11), baseline);
    }

    function _digest(bytes32 source, bytes32 sources, uint256 feeBps) private view returns (bytes32) {
        return script.computeDeploymentPlanDigest(
            source,
            sources,
            keccak256("compiler"),
            keccak256("creation"),
            keccak256("runtime"),
            keccak256("init"),
            keccak256("constructor"),
            USDC,
            address(0xA),
            OWNER,
            FEE,
            feeBps,
            keccak256("resources")
        );
    }
}
