import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertPlanDigest, buildDeploymentPlan, validateDeploymentInput, validateMainnetManifest } from "./mainnet-deployment-plan.mjs";

export const artifact = {
  abi: [{ type: "constructor", inputs: [{ name: "_canonicalUsdc", type: "address" }, { name: "initialOwner", type: "address" }, { name: "_feeCollector", type: "address" }, { name: "_feeBps", type: "uint256" }] }],
  bytecode: { object: "0x60006000556001600055" },
  deployedBytecode: { object: `0x${"00".repeat(64)}`, immutableReferences: { "1": [{ start: 16, length: 32 }] } },
  metadata: {
    compiler: { version: "0.8.24+commit.e11b9ed9" },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true, metadata: { bytecodeHash: "ipfs" }, compilationTarget: { "src/WizPayMainnetV2.sol": "WizPayMainnetV2" }, remappings: ["forge-std/=lib/forge-std/src/"], libraries: {} },
    sources: { "src/WizPayMainnetV2.sol": { keccak256: `0x${"12".repeat(32)}` } },
  },
};
export const base = {
  schemaVersion: 3, deploymentManifestSchemaVersion: 2, network: "arc-mainnet", chainId: 5042, contract: "WizPayMainnetV2",
  canonicalUsdc: "0x3600000000000000000000000000000000000000", owner: "0x12345678901234567890123456789012345689ab",
  feeRecipient: "0x1234567890123456789012345678901234569abc", feeBps: "10", deployer: "0x123456789012345678901234567890123456abcd",
  auditedCommit: "2ce70d17d9e5ecd142122b0fec6e01506d92b08a", authorizationEvidencePath: null,
};
export const resources = { schemaVersion: 1, network: "arc-mainnet", resources: { marker: "fixture" }, capabilities: {} };
export const planDependencies = { resourceManifest: resources, sourceCommit: base.auditedCommit };

test("accepts only canonical integer strings and the explicitly audited Git HEAD", () => {
  assert.equal(validateDeploymentInput(base).feeBps, "10");
  for (const feeBps of [10, "01", "1.0", "101"]) assert.throws(() => validateDeploymentInput({ ...base, feeBps }));
  assert.throws(() => validateDeploymentInput({ ...base, auditedCommit: "2ce70d1" }), /40-character/);
  assert.throws(() => buildDeploymentPlan(base, artifact, { ...planDependencies, sourceCommit: "f".repeat(40) }), /audited commit/);
});

test("recomputes hashes and binds every readable input and compiler field", () => {
  const first = buildDeploymentPlan(base, artifact, planDependencies);
  assert.equal(assertPlanDigest(first), true);
  const inputMutations = [
    { feeBps: "11" }, { canonicalUsdc: "0x123456789012345678901234567890123456789a" },
    { owner: "0x22345678901234567890123456789012345689ab" }, { feeRecipient: "0x2234567890123456789012345678901234569abc" },
    { deployer: "0x223456789012345678901234567890123456abcd" },
  ];
  for (const mutation of inputMutations) assert.notEqual(buildDeploymentPlan({ ...base, ...mutation }, artifact, planDependencies).planDigest, first.planDigest);
  const bytecodeMutations = [
    { ...artifact, bytecode: { object: "0x6001600055" } },
    { ...artifact, deployedBytecode: { ...artifact.deployedBytecode, object: `0x${"11".repeat(64)}` } },
    { ...artifact, metadata: { ...artifact.metadata, sources: { "src/WizPayMainnetV2.sol": { keccak256: `0x${"34".repeat(32)}` } } } },
  ];
  for (const changed of bytecodeMutations) assert.notEqual(buildDeploymentPlan(base, changed, planDependencies).planDigest, first.planDigest);
  const policyMutations = ["evmVersion", "viaIR", "compilationTarget"].map((field) => ({ ...artifact, metadata: { ...artifact.metadata, settings: { ...artifact.metadata.settings, [field]: field === "evmVersion" ? "prague" : field === "viaIR" ? false : { "src/Other.sol": "Other" } } } }));
  for (const changed of policyMutations) assert.throws(() => buildDeploymentPlan(base, changed, planDependencies), /compiler configuration|deployment policy/);
  for (const settings of [
    { remappings: ["x/=y/"] },
    { libraries: { "A.sol": { A: base.owner } } },
    { metadata: { bytecodeHash: "none" } },
    { debug: { revertStrings: "strip" } },
  ]) assert.notEqual(buildDeploymentPlan(base, { ...artifact, metadata: { ...artifact.metadata, settings: { ...artifact.metadata.settings, ...settings } } }, planDependencies).planDigest, first.planDigest);
  assert.notEqual(buildDeploymentPlan(base, artifact, { ...planDependencies, resourceManifest: { ...resources, marker: "changed" } }).planDigest, first.planDigest);
  assert.throws(() => assertPlanDigest({ ...first, feeBps: "12" }), /digest mismatch/);
});

test("does not accept caller-supplied derived hashes", () => {
  for (const field of ["sourceCommitDigest", "compilerDigest", "creationBytecodeHash", "runtimeBytecodeHash", "initCodeHash", "constructorDigest", "resourceManifestDigest", "authorizationEvidenceDigest"]) assert.throws(() => validateDeploymentInput({ ...base, [field]: `0x${"ab".repeat(32)}` }), /unknown or missing/);
});

test("keeps the committed deployment manifest explicitly unavailable", async () => {
  const manifest = JSON.parse(await readFile(new URL("../deployments/arc-mainnet-wizpay-v2.json", import.meta.url), "utf8"));
  assert.equal(validateMainnetManifest(manifest), true);
  assert.throws(() => validateMainnetManifest({ ...manifest, status: "deployed" }), /bytes32/);
});

test("deployment pipeline contains no raw-private-key environment support", async () => {
  const files = ["mainnet-deployment-plan.mjs", "mainnet-preflight.mjs", "mainnet-post-deployment-verify.mjs", "../script/DeployWizPayMainnetV2.s.sol"];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /DEPLOYER_PRIVATE_KEY|PRIVATE_KEY|envUint\([^)]*KEY|startBroadcast\([^)]/);
  }
});
