import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertResourceTransition, canonicalDigest, resourceManifestDigest, validateResource, validateResourceManifest } from "./mainnet-resource-state.mjs";

const unavailable = { state: "unavailable", reason: "NOT_CONFIRMED" };
const candidate = { state: "candidate", value: 5042, evidence: "read-only observation" };
const relativeRecord = "packages/contracts/deployments/authoritative-records/fixtures/chain-id.json";

async function fixture(overrides = {}) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "wizpay-resource-record-"));
  const recordPath = join(repositoryRoot, relativeRecord);
  await mkdir(join(recordPath, ".."), { recursive: true });
  const record = {
    schemaVersion: 1,
    recordType: "arc-mainnet-authoritative-resource",
    fixtureOnly: true,
    authority: "Arc",
    network: { name: "Circle Arc Mainnet", key: "arc-mainnet", chainId: "5042" },
    resource: { type: "chainId", value: { value: 5042 } },
    publication: { reference: "TEST_FIXTURE_ONLY", publishedAt: "2026-01-01T00:00:00.000Z", releaseId: null },
    ...overrides,
  };
  await writeFile(recordPath, `${JSON.stringify(record)}\n`);
  const resource = {
    state: "official",
    value: 5042,
    authoritativeSource: { recordPath: relativeRecord, recordDigest: canonicalDigest(record), authority: "Arc", reference: "TEST_FIXTURE_ONLY" },
  };
  return { repositoryRoot, recordPath, record, resource, options: { repositoryRoot, allowTestFixtures: true, resourceType: "chainId", isGitTracked: () => true } };
}

test("validates unavailable and candidate states without granting final authority", () => {
  assert.equal(validateResource(unavailable, "resource"), true);
  assert.equal(validateResource(candidate, "resource"), true);
  assert.throws(() => validateResource({ state: "official", value: 5042 }, "resource"), /authoritativeSource/);
});

test("accepts an explicitly test-only tracked fixture and verifies its content digest", async () => {
  const value = await fixture();
  assert.equal(validateResource(value.resource, "chainId", value.options), true);
  assert.throws(() => validateResource({ ...value.resource, authoritativeSource: { ...value.resource.authoritativeSource, recordDigest: `0x${"ab".repeat(32)}` } }, "chainId", value.options), /digest mismatch/);
});

test("rejects nonexistent, traversal, symlink, directory, and untracked records", async () => {
  const value = await fixture();
  const source = value.resource.authoritativeSource;
  assert.throws(() => validateResource({ ...value.resource, authoritativeSource: { ...source, recordPath: "packages/contracts/deployments/authoritative-records/missing.json" } }, "chainId", value.options), /does not exist/);
  assert.throws(() => validateResource({ ...value.resource, authoritativeSource: { ...source, recordPath: "packages/contracts/deployments/authoritative-records/../../arc-mainnet-resources.json" } }, "chainId", value.options), /must be inside/);
  const link = join(value.repositoryRoot, "packages/contracts/deployments/authoritative-records/link.json");
  await symlink(value.recordPath, link);
  assert.throws(() => validateResource({ ...value.resource, authoritativeSource: { ...source, recordPath: "packages/contracts/deployments/authoritative-records/link.json" } }, "chainId", value.options), /symlink/);
  assert.throws(() => validateResource({ ...value.resource, authoritativeSource: { ...source, recordPath: "packages/contracts/deployments/authoritative-records/fixtures" } }, "chainId", value.options), /regular file/);
  assert.throws(() => validateResource(value.resource, "chainId", { ...value.options, isGitTracked: () => false }), /Git-tracked/);
});

test("rejects wrong authority, chain, type, resource value, publication, and production use of fixtures", async () => {
  const value = await fixture();
  assert.throws(() => validateResource({ ...value.resource, authoritativeSource: { ...value.resource.authoritativeSource, authority: "Circle" } }, "chainId", value.options), /not supported/);
  for (const changed of [
    { network: { ...value.record.network, chainId: "9999" } },
    { resource: { ...value.record.resource, type: "canonicalUsdc" } },
    { resource: { ...value.record.resource, value: { value: 1 } } },
    { publication: { reference: "", publishedAt: null, releaseId: null } },
  ]) {
    const next = await fixture(changed);
    assert.throws(() => validateResource(next.resource, "chainId", next.options));
  }
  assert.throws(() => validateResource(value.resource, "chainId", { ...value.options, allowTestFixtures: false }), /fixture evidence/);
});

test("allows reviewed transitions but forbids direct unavailable-to-official promotion", async () => {
  const value = await fixture();
  assert.equal(assertResourceTransition(candidate, value.resource, "chainId", value.options), true);
  assert.throws(() => assertResourceTransition(unavailable, value.resource, "chainId", value.options), /forbidden/);
});

test("committed candidate manifest is deterministic and cannot authorize final preflight", async () => {
  const manifest = JSON.parse(await readFile(new URL("../deployments/arc-mainnet-resources.json", import.meta.url), "utf8"));
  assert.equal(validateResourceManifest(manifest), true);
  assert.match(resourceManifestDigest(manifest), /^0x[0-9a-f]{64}$/);
  assert.throws(() => validateResourceManifest(manifest, { requireOfficial: true }), /must be official/);
  assert.equal(manifest.resources.canonicalUsdc.state, "candidate");
});
