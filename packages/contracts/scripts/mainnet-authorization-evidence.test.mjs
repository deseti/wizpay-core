import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeFunctionResult, parseAbi, toFunctionSelector } from "viem";
import { canonicalDigest, stableJson } from "./mainnet-resource-state.mjs";
import {
  createSafeEip1271Verifier,
  verifyAuthorizationEvidence,
} from "./mainnet-authorization-evidence.mjs";
import {
  artifact,
  base,
  planDependencies,
} from "./mainnet-deployment-plan.test.mjs";
import { buildDeploymentPlan } from "./mainnet-deployment-plan.mjs";

const plan = buildDeploymentPlan(base, artifact, planDependencies);

async function authorization(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "wizpay-authorization-"));
  const path =
    "packages/contracts/deployments/authorization-records/fixtures/release.json";
  await mkdir(
    join(root, "packages/contracts/deployments/authorization-records/fixtures"),
    { recursive: true },
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const releaseId = "release-8a-fixture";
  const payload = {
    planDigest: plan.planDigest,
    chainId: "5042",
    creationBytecodeHash: plan.creationBytecodeHash,
    runtimeBytecodeHash: plan.runtimeBytecodeHash,
    deployer: plan.deployer,
    finalSafeOwner: plan.owner,
    feeRecipient: plan.feeRecipient,
    feeBps: plan.feeBps,
    resourceManifestDigest: plan.resourceManifestDigest,
    releaseId,
    ...(overrides.payload ?? {}),
  };
  const record = {
    schemaVersion: 1,
    recordType: "wizpay-mainnet-deployment-authorization",
    fixtureOnly: true,
    method: "ed25519-test-fixture-v1",
    releaseId,
    createdAt: "2026-09-14T00:00:00.000Z",
    expiresAt: "2026-09-16T00:00:00.000Z",
    safe: plan.owner,
    signer: plan.owner,
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    payload,
    signature: sign(
      null,
      Buffer.from(stableJson(payload)),
      privateKey,
    ).toString("base64"),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "payload"),
    ),
  };
  await writeFile(join(root, path), `${JSON.stringify(record)}\n`);
  return {
    reference: {
      state: "authorized",
      recordPath: path,
      recordDigest: canonicalDigest(record),
    },
    options: {
      repositoryRoot: root,
      isGitTracked: () => true,
      allowTestFixtures: true,
      now: "2026-09-15T00:00:00.000Z",
    },
  };
}

async function safeAuthorization(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "wizpay-safe-authorization-"));
  const path =
    "packages/contracts/deployments/authorization-records/release.json";
  await mkdir(
    join(root, "packages/contracts/deployments/authorization-records"),
    { recursive: true },
  );
  const releaseId = overrides.releaseId ?? "release-mainnet-1";
  const payload = {
    planDigest: plan.planDigest,
    chainId: "5042",
    creationBytecodeHash: plan.creationBytecodeHash,
    runtimeBytecodeHash: plan.runtimeBytecodeHash,
    deployer: plan.deployer,
    finalSafeOwner: plan.owner,
    feeRecipient: plan.feeRecipient,
    feeBps: plan.feeBps,
    resourceManifestDigest: plan.resourceManifestDigest,
    releaseId,
    ...(overrides.payload ?? {}),
  };
  const record = {
    schemaVersion: 1,
    recordType: "wizpay-mainnet-deployment-authorization",
    fixtureOnly: false,
    method: "safe-eip1271-v1",
    releaseId,
    createdAt: "2026-09-14T00:00:00.000Z",
    expiresAt: "2026-09-16T00:00:00.000Z",
    safe: plan.owner,
    signer: "0x223456789012345678901234567890123456789a",
    publicKey: null,
    signature: `0x${"ab".repeat(65)}`,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => !["payload", "verifySafeSignature"].includes(key),
      ),
    ),
    payload,
  };
  await writeFile(join(root, path), `${JSON.stringify(record)}\n`);
  return {
    record,
    reference: {
      state: "authorized",
      recordPath: path,
      recordDigest: canonicalDigest(record),
    },
    options: {
      repositoryRoot: root,
      isGitTracked: () => true,
      now: "2026-09-15T00:00:00.000Z",
      verifySafeSignature: overrides.verifySafeSignature ?? (async () => true),
    },
  };
}

test("verifies a valid tracked fixture authorization bound to the exact plan", async () => {
  const value = await authorization();
  const verified = await verifyAuthorizationEvidence(
    plan,
    value.reference,
    value.options,
  );
  assert.equal(verified.state, "authorized");
  assert.equal(verified.safe, plan.owner);
});

test("rejects missing, expired, wrong signer or Safe, wrong plan, chain, fee, and digest evidence", async () => {
  await assert.rejects(
    verifyAuthorizationEvidence(plan, null),
    /not evidence-authorized/,
  );
  const expired = await authorization({
    expiresAt: "2026-09-14T12:00:00.000Z",
  });
  await assert.rejects(
    verifyAuthorizationEvidence(plan, expired.reference, expired.options),
    /expired/,
  );
  for (const change of [
    { signer: base.deployer },
    { safe: base.deployer },
    { payload: { planDigest: `0x${"11".repeat(32)}` } },
    { payload: { chainId: "9999" } },
    { payload: { feeBps: "11" } },
    { payload: { resourceManifestDigest: `0x${"22".repeat(32)}` } },
  ]) {
    const value = await authorization(change);
    await assert.rejects(
      verifyAuthorizationEvidence(plan, value.reference, value.options),
    );
  }
  const mismatch = await authorization();
  await assert.rejects(
    verifyAuthorizationEvidence(
      plan,
      { ...mismatch.reference, recordDigest: `0x${"ff".repeat(32)}` },
      mismatch.options,
    ),
    /digest mismatch/,
  );
});

test("production mode rejects fixture authorization", async () => {
  const value = await authorization();
  await assert.rejects(
    verifyAuthorizationEvidence(plan, value.reference, {
      ...value.options,
      allowTestFixtures: false,
    }),
    /Fixture authorization/,
  );
});

test("accepts production evidence only when EIP-1271 verifies the exact bound digest", async () => {
  let verification;
  const value = await safeAuthorization({
    verifySafeSignature: async (input) => {
      verification = input;
      return true;
    },
  });
  const verified = await verifyAuthorizationEvidence(
    plan,
    value.reference,
    value.options,
  );
  assert.equal(verified.method, "safe-eip1271-v1");
  assert.equal(
    verification.payloadDigest,
    canonicalDigest(value.record.payload),
  );
  assert.equal(verification.safe, plan.owner);
  assert.equal(verification.signer, value.record.signer);
});

test("rejects invalid production signature, chain, Safe owner, expiry, release ID, and payload binding", async () => {
  const badSignature = await safeAuthorization({
    verifySafeSignature: async () => false,
  });
  await assert.rejects(
    verifyAuthorizationEvidence(
      plan,
      badSignature.reference,
      badSignature.options,
    ),
    /EIP-1271/,
  );
  for (const change of [
    { payload: { chainId: "9999" } },
    { safe: base.deployer },
    { expiresAt: "2026-09-15T00:00:00.000Z" },
    { releaseId: "invalid release id" },
    { payload: { planDigest: `0x${"ef".repeat(32)}` } },
  ]) {
    const value = await safeAuthorization(change);
    await assert.rejects(
      verifyAuthorizationEvidence(plan, value.reference, value.options),
    );
  }
});

test("Safe verifier requires Arc Mainnet, contract code, a current Safe owner, and the EIP-1271 magic value on both RPCs", async () => {
  const abi = parseAbi([
    "function getOwners() view returns (address[])",
    "function isValidSignature(bytes32,bytes) view returns (bytes4)",
  ]);
  const signer = "0x223456789012345678901234567890123456789a";
  const client = ({
    chainId = 5042,
    code = "0x6000",
    owners = [signer],
    magic = "0x1626ba7e",
  } = {}) => ({
    async request(method, params = []) {
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (method === "eth_getCode") return code;
      if (method === "eth_call") {
        const selector = params[0].data.slice(0, 10);
        if (selector === toFunctionSelector("getOwners()"))
          return encodeFunctionResult({
            abi,
            functionName: "getOwners",
            result: owners,
          });
        return encodeFunctionResult({
          abi,
          functionName: "isValidSignature",
          result: magic,
        });
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  const request = {
    safe: plan.owner,
    signer,
    payloadDigest: plan.planDigest,
    signature: `0x${"ab".repeat(65)}`,
  };
  assert.equal(
    await createSafeEip1271Verifier([client(), client()])(request),
    true,
  );
  for (const changed of [
    client({ chainId: 9999 }),
    client({ code: "0x" }),
    client({ owners: [base.deployer] }),
    client({ magic: "0xffffffff" }),
  ]) {
    assert.equal(
      await createSafeEip1271Verifier([client(), changed])(request),
      false,
    );
  }
});
