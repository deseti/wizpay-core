import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildDeploymentPlan,
  validateDeploymentInput,
  validateMainnetManifest,
} from "./mainnet-deployment-plan.mjs";

const artifact = {
  abi: [
    {
      type: "constructor",
      inputs: [
        { name: "_canonicalUsdc", type: "address" },
        { name: "initialOwner", type: "address" },
        { name: "_feeCollector", type: "address" },
        { name: "_feeBps", type: "uint256" },
      ],
    },
  ],
  bytecode: { object: "0x60006000556001600055" },
};
const base = {
  schemaVersion: 1,
  network: "arc-mainnet",
  chainId: 5042,
  contract: "WizPayMainnetV2",
  canonicalUsdc: "0x123456789012345678901234567890123456789a",
  safeOwner: "0x12345678901234567890123456789012345689ab",
  safeOwnerAuthorization: "PROJECT_OWNER_APPROVED_MAINNET_SAFE",
  feeRecipient: "0x1234567890123456789012345678901234569abc",
  feeBps: 10,
  feeConfigurationAuthorization: "PROJECT_OWNER_APPROVED_FEE_CONFIGURATION",
  deployer: "0x123456789012345678901234567890123456abcd",
  sourceCommit: "0cb70bd8aaf48f2b7660e8a1f9d34d9e918ed8b8",
  compiler: {
    version: "0.8.24",
    optimizer: true,
    optimizerRuns: 200,
    viaIR: true,
  },
};

test("rejects any chain other than Arc Mainnet 5042", () => {
  assert.throws(
    () => validateDeploymentInput({ ...base, chainId: 5_042_002 }),
    /5042/,
  );
});

test("rejects missing, placeholder, zero, deployer-owned, and unauthorized inputs", () => {
  assert.throws(
    () => validateDeploymentInput({ ...base, canonicalUsdc: "UNAVAILABLE" }),
    /explicit non-placeholder/,
  );
  assert.throws(
    () =>
      validateDeploymentInput({
        ...base,
        feeRecipient: "0x0000000000000000000000000000000000000000",
      }),
    /zero or a placeholder/,
  );
  assert.throws(
    () => validateDeploymentInput({ ...base, safeOwner: base.deployer }),
    /deployment EOA/,
  );
  assert.throws(
    () =>
      validateDeploymentInput({
        ...base,
        safeOwnerAuthorization: "UNAVAILABLE",
      }),
    /authorization/,
  );
  assert.throws(
    () => validateDeploymentInput({ ...base, feeBps: null }),
    /approved integer/,
  );
});

test("rejects known Arc Testnet contracts, tokens, owner, fee recipient, and deployer", () => {
  for (const [field, value] of [
    ["canonicalUsdc", "0x3600000000000000000000000000000000000000"],
    ["safeOwner", "0xAA557eb00063ad487BFe0304Bd04B4d45114b721"],
    ["feeRecipient", "0x32F251fc36A1174901124589EAC2d4E391816F69"],
    ["deployer", "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed"],
  ])
    assert.throws(
      () => validateDeploymentInput({ ...base, [field]: value }),
      /known Arc Testnet/,
    );
});

test("identical inputs produce the same plan and any constructor change changes its digest", () => {
  const first = buildDeploymentPlan(base, artifact);
  const second = buildDeploymentPlan(
    structuredClone(base),
    structuredClone(artifact),
  );
  assert.deepEqual(first, second);
  assert.equal(first.planDigest, second.planDigest);
  assert.notEqual(
    first.planDigest,
    buildDeploymentPlan({ ...base, feeBps: 11 }, artifact).planDigest,
  );
  assert.notEqual(
    first.constructorDigest,
    buildDeploymentPlan({ ...base, feeBps: 11 }, artifact).constructorDigest,
  );
});

test("committed Mainnet manifest remains unavailable and complete receipt evidence is mandatory", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../deployments/arc-mainnet-wizpay-v2.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(validateMainnetManifest(manifest), true);
  assert.throws(
    () => validateMainnetManifest({ ...manifest, status: "deployed" }),
    /explicit non-placeholder|incomplete/,
  );
  assert.throws(
    () => validateMainnetManifest({ ...manifest, chainId: 5_042_002 }),
    /identity/,
  );
  assert.throws(
    () =>
      validateMainnetManifest({
        ...manifest,
        deploymentResult: {
          ...manifest.deploymentResult,
          transactionHash: `0x${"a".repeat(64)}`,
        },
      }),
    /Unavailable manifest/,
  );
});
