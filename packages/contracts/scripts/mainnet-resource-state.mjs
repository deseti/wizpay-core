import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { keccak256, toHex } from "viem";

export const RESOURCE_STATES = Object.freeze(["unavailable", "candidate", "official"]);
export const AUTHORITATIVE_RECORD_DIRECTORY = "packages/contracts/deployments/authoritative-records";
export const AUTHORITATIVE_RECORD_SCHEMA_VERSION = 1;
const OFFICIAL_SOURCE_KEYS = ["recordPath", "recordDigest", "authority", "reference"];
const RECORD_KEYS = ["schemaVersion", "recordType", "fixtureOnly", "authority", "network", "resource", "publication"];
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function fail(message) { throw new Error(message); }
export function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} has unknown or missing fields.`);
}
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  return JSON.stringify(value);
}
export function canonicalDigest(value) { return keccak256(toHex(stableJson(value))); }
export function resourceManifestDigest(manifest) { return canonicalDigest(manifest); }

function defaultGitTracked(repositoryRoot, relativePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 && result.stdout.trim() === relativePath;
}

function loadAuthoritativeRecord(source, label, options) {
  exactKeys(source, OFFICIAL_SOURCE_KEYS, `${label}.authoritativeSource`);
  if (!/^(Arc|Circle)$/.test(source.authority)) fail(`${label} official authority must be Arc or Circle.`);
  if (typeof source.reference !== "string" || source.reference.trim().length === 0) fail(`${label} official source reference is required.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(source.recordDigest)) fail(`${label} source record digest is invalid.`);
  if (typeof source.recordPath !== "string" || source.recordPath.includes("\\") || isAbsolute(source.recordPath)) fail(`${label} authoritative record path is invalid.`);
  const repositoryRoot = realpathSync(options.repositoryRoot ?? REPOSITORY_ROOT);
  const allowedRoot = realpathSync(resolve(repositoryRoot, AUTHORITATIVE_RECORD_DIRECTORY));
  const requested = resolve(repositoryRoot, source.recordPath);
  if (!requested.startsWith(`${allowedRoot}${sep}`)) fail(`${label} authoritative record must be inside ${AUTHORITATIVE_RECORD_DIRECTORY}.`);
  let stat;
  try { stat = lstatSync(requested); } catch { fail(`${label} authoritative record does not exist.`); }
  if (stat.isSymbolicLink()) fail(`${label} authoritative record must not be a symlink.`);
  if (!stat.isFile()) fail(`${label} authoritative record must be a regular file.`);
  const real = realpathSync(requested);
  if (!real.startsWith(`${allowedRoot}${sep}`)) fail(`${label} authoritative record resolves outside the allowed root.`);
  const repositoryRelative = relative(repositoryRoot, real).split(sep).join("/");
  const isTracked = options.isGitTracked ?? defaultGitTracked;
  if (!isTracked(repositoryRoot, repositoryRelative)) fail(`${label} authoritative record must be Git-tracked.`);
  let record;
  try { record = JSON.parse(readFileSync(real, "utf8")); } catch { fail(`${label} authoritative record is malformed.`); }
  exactKeys(record, RECORD_KEYS, `${label} authoritative record`);
  if (record.schemaVersion !== AUTHORITATIVE_RECORD_SCHEMA_VERSION || record.recordType !== "arc-mainnet-authoritative-resource") fail(`${label} authoritative record schema is unsupported.`);
  if (record.fixtureOnly !== false && !(options.allowTestFixtures === true && record.fixtureOnly === true)) fail(`${label} fixture evidence cannot authorize production resources.`);
  if (record.authority !== source.authority) fail(`${label} caller-supplied authority is not supported by the record.`);
  exactKeys(record.network, ["name", "key", "chainId"], `${label} record network`);
  if (record.network.name !== "Circle Arc Mainnet" || record.network.key !== "arc-mainnet" || record.network.chainId !== "5042") fail(`${label} authoritative record has the wrong Circle Arc network identity.`);
  exactKeys(record.resource, ["type", "value"], `${label} record resource`);
  if (record.resource.type !== options.resourceType) fail(`${label} authoritative record has the wrong resource type.`);
  exactKeys(record.publication, ["reference", "publishedAt", "releaseId"], `${label} record publication`);
  if (record.publication.reference !== source.reference) fail(`${label} publication reference mismatch.`);
  const hasTimestamp = typeof record.publication.publishedAt === "string" && !Number.isNaN(Date.parse(record.publication.publishedAt));
  const hasRelease = typeof record.publication.releaseId === "string" && record.publication.releaseId.trim().length > 0;
  if (!hasTimestamp && !hasRelease) fail(`${label} record requires a publication timestamp or release identifier.`);
  if (canonicalDigest(record) !== source.recordDigest.toLowerCase()) fail(`${label} authoritative record digest mismatch.`);
  return record;
}

function resourceValue(resource) { return Object.fromEntries(Object.entries(resource).filter(([key]) => key !== "state" && key !== "authoritativeSource")); }

export function validateResource(resource, label, options = {}) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource) || !RESOURCE_STATES.includes(resource.state)) fail(`${label} has an invalid resource state.`);
  if (resource.state === "unavailable") {
    if (typeof resource.reason !== "string" || resource.reason.length === 0) fail(`${label} unavailable state requires a reason.`);
    return true;
  }
  if (resource.state === "candidate") {
    if (typeof resource.evidence !== "string" || resource.evidence.length === 0) fail(`${label} candidate state requires evidence.`);
    return true;
  }
  const record = loadAuthoritativeRecord(resource.authoritativeSource, label, options);
  if (stableJson(record.resource.value) !== stableJson(resourceValue(resource))) fail(`${label} authoritative record does not reconcile with the manifest resource values.`);
  return true;
}

export function assertResourceTransition(previous, next, label = "resource", options = {}) {
  validateResource(previous, `${label}.previous`, options); validateResource(next, `${label}.next`, options);
  const allowed = new Set(["unavailable:unavailable", "unavailable:candidate", "candidate:candidate", "candidate:official", "candidate:unavailable", "official:official", "official:unavailable"]);
  if (!allowed.has(`${previous.state}:${next.state}`)) fail(`${label} transition ${previous.state} -> ${next.state} is forbidden.`);
  return true;
}

export function validateResourceManifest(manifest, options = {}) {
  const { requireOfficial = false } = options;
  exactKeys(manifest, ["schemaVersion", "network", "resources", "capabilities"], "Resource manifest");
  if (manifest.schemaVersion !== 1 || manifest.network !== "arc-mainnet") fail("Resource manifest identity is invalid.");
  exactKeys(manifest.resources, ["chainId", "rpcEndpoints", "explorerUrl", "canonicalUsdc", "nativeGas", "erc20UsdcDecimals", "circleBlockchainIdentifier", "deploymentStatus"], "resources");
  if (!Array.isArray(manifest.resources.rpcEndpoints) || manifest.resources.rpcEndpoints.length < 2) fail("At least two independently configured RPC resource slots are required.");
  for (const [key, resource] of Object.entries(manifest.resources)) {
    if (Array.isArray(resource)) resource.forEach((entry, index) => validateResource(entry, `${key}[${index}]`, { ...options, resourceType: `${key}[${index}]` }));
    else validateResource(resource, key, { ...options, resourceType: key });
  }
  if (manifest.resources.chainId.value !== 5042) fail("Arc Mainnet chain ID must be 5042.");
  if (manifest.resources.canonicalUsdc.decimals !== 6 || manifest.resources.erc20UsdcDecimals.value !== 6) fail("Canonical ERC-20 USDC must use 6 decimals.");
  if (manifest.resources.nativeGas.decimals !== 18) fail("Native gas units must use 18 decimals.");
  if (manifest.resources.deploymentStatus.state !== "unavailable") fail("Pre-deployment resource manifest must remain undeployed.");
  const forbidden = ["uniswapSwap", "crossTokenPayroll", "stable" + "Fx", "xylo" + "Net", "cctp", "gateway", "bridge"];
  if (forbidden.some((name) => manifest.capabilities[name] !== false)) fail("Deferred Mainnet integrations must remain disabled.");
  if (requireOfficial) {
    for (const key of ["chainId", "explorerUrl", "canonicalUsdc", "nativeGas", "erc20UsdcDecimals", "circleBlockchainIdentifier"]) if (manifest.resources[key].state !== "official") fail(`${key} must be official for final deployment preflight.`);
    if (manifest.resources.rpcEndpoints.some((entry) => entry.state !== "official")) fail("Both RPC endpoints must be official for final deployment preflight.");
  }
  return true;
}
