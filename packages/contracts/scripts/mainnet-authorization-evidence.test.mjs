import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest, stableJson } from "./mainnet-resource-state.mjs";
import { verifyAuthorizationEvidence } from "./mainnet-authorization-evidence.mjs";
import { artifact, base, planDependencies } from "./mainnet-deployment-plan.test.mjs";
import { buildDeploymentPlan } from "./mainnet-deployment-plan.mjs";

const plan = buildDeploymentPlan(base, artifact, planDependencies);

async function authorization(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "wizpay-authorization-"));
  const path = "packages/contracts/deployments/authorization-records/fixtures/release.json";
  await mkdir(join(root, "packages/contracts/deployments/authorization-records/fixtures"), { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const releaseId = "release-8a-fixture";
  const payload = {
    planDigest: plan.planDigest, chainId: "5042", creationBytecodeHash: plan.creationBytecodeHash,
    runtimeBytecodeHash: plan.runtimeBytecodeHash, deployer: plan.deployer, finalSafeOwner: plan.owner,
    feeRecipient: plan.feeRecipient, feeBps: plan.feeBps, resourceManifestDigest: plan.resourceManifestDigest, releaseId,
    ...(overrides.payload ?? {}),
  };
  const record = {
    schemaVersion: 1, recordType: "wizpay-mainnet-deployment-authorization", fixtureOnly: true,
    method: "ed25519-test-fixture-v1", releaseId, createdAt: "2026-09-14T00:00:00.000Z", expiresAt: "2026-09-16T00:00:00.000Z",
    safe: plan.owner, signer: plan.owner, publicKey: publicKey.export({ type: "spki", format: "pem" }), payload,
    signature: sign(null, Buffer.from(stableJson(payload)), privateKey).toString("base64"),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "payload")),
  };
  await writeFile(join(root, path), `${JSON.stringify(record)}\n`);
  return { reference: { state: "authorized", recordPath: path, recordDigest: canonicalDigest(record) }, options: { repositoryRoot: root, isGitTracked: () => true, allowTestFixtures: true, now: "2026-09-15T00:00:00.000Z" } };
}

test("verifies a valid tracked fixture authorization bound to the exact plan", async () => {
  const value = await authorization();
  const verified = await verifyAuthorizationEvidence(plan, value.reference, value.options);
  assert.equal(verified.state, "authorized");
  assert.equal(verified.safe, plan.owner);
});

test("rejects missing, expired, wrong signer or Safe, wrong plan, chain, fee, and digest evidence", async () => {
  await assert.rejects(verifyAuthorizationEvidence(plan, null), /not evidence-authorized/);
  const expired = await authorization({ expiresAt: "2026-09-14T12:00:00.000Z" });
  await assert.rejects(verifyAuthorizationEvidence(plan, expired.reference, expired.options), /expired/);
  for (const change of [
    { signer: base.deployer }, { safe: base.deployer },
    { payload: { planDigest: `0x${"11".repeat(32)}` } }, { payload: { chainId: "5042002" } },
    { payload: { feeBps: "11" } }, { payload: { resourceManifestDigest: `0x${"22".repeat(32)}` } },
  ]) {
    const value = await authorization(change);
    await assert.rejects(verifyAuthorizationEvidence(plan, value.reference, value.options));
  }
  const mismatch = await authorization();
  await assert.rejects(verifyAuthorizationEvidence(plan, { ...mismatch.reference, recordDigest: `0x${"ff".repeat(32)}` }, mismatch.options), /digest mismatch/);
});

test("production mode rejects fixture authorization", async () => {
  const value = await authorization();
  await assert.rejects(verifyAuthorizationEvidence(plan, value.reference, { ...value.options, allowTestFixtures: false }), /Fixture authorization/);
});
