import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeAbiParameters, encodeDeployData, getAddress, isAddress, keccak256, parseAbiParameters, toHex } from "viem";
import { canonicalDigest, exactKeys, fail, resourceManifestDigest, stableJson } from "./mainnet-resource-state.mjs";
import { loadAuthorizationEvidence } from "./mainnet-authorization-evidence.mjs";

export { exactKeys, fail } from "./mainnet-resource-state.mjs";
export const MAINNET_CHAIN_ID = 5042;
export const NETWORK = "arc-mainnet";
export const CONTRACT = "WizPayMainnetV2";
export const PLAN_SCHEMA_VERSION = 3;
export const DEPLOYMENT_MANIFEST_SCHEMA_VERSION = 2;
export const MAX_FEE_BPS = 100n;
const INPUT_KEYS = ["schemaVersion", "deploymentManifestSchemaVersion", "network", "chainId", "contract", "canonicalUsdc", "owner", "feeRecipient", "feeBps", "deployer", "auditedCommit", "authorizationEvidencePath"];
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function normalizeAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value)) fail(`${label} must be an explicit EVM address.`);
  const normalized = getAddress(value);
  if (normalized === "0x0000000000000000000000000000000000000000") fail(`${label} must not be zero.`);
  return normalized;
}
export function bytes32(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`${label} must be a bytes32 hex value.`);
  return value.toLowerCase();
}
function uintString(value, label, maximum) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) fail(`${label} must be a canonical unsigned integer string.`);
  const parsed = BigInt(value);
  if (maximum !== undefined && parsed > maximum) fail(`${label} exceeds its maximum.`);
  return parsed.toString();
}
export function validateDeploymentInput(raw) {
  exactKeys(raw, INPUT_KEYS, "Deployment input");
  if (raw.schemaVersion !== PLAN_SCHEMA_VERSION || raw.deploymentManifestSchemaVersion !== DEPLOYMENT_MANIFEST_SCHEMA_VERSION || raw.network !== NETWORK || raw.chainId !== MAINNET_CHAIN_ID || raw.contract !== CONTRACT) fail("Deployment identity must be WizPayMainnetV2 on arc-mainnet chain 5042 with schema version 3.");
  const canonicalUsdc = normalizeAddress(raw.canonicalUsdc, "canonicalUsdc");
  const owner = normalizeAddress(raw.owner, "owner");
  const feeRecipient = normalizeAddress(raw.feeRecipient, "feeRecipient");
  const deployer = normalizeAddress(raw.deployer, "deployer");
  if (owner === deployer) fail("owner must not equal the deployment EOA.");
  if ([owner, feeRecipient, deployer].includes(canonicalUsdc)) fail("canonicalUsdc must be distinct from owner, fee recipient, and deployer.");
  const feeBps = uintString(raw.feeBps, "feeBps", MAX_FEE_BPS);
  if (typeof raw.auditedCommit !== "string" || !/^[0-9a-f]{40}$/.test(raw.auditedCommit)) fail("auditedCommit must be a lowercase full 40-character Git SHA.");
  if (raw.authorizationEvidencePath !== null && (typeof raw.authorizationEvidencePath !== "string" || raw.authorizationEvidencePath.length === 0)) fail("authorizationEvidencePath must be a repository-relative path or null.");
  return Object.freeze({ ...raw, canonicalUsdc, owner, feeRecipient, deployer, feeBps });
}

function metadataOf(artifact) {
  const metadata = artifact?.metadata;
  if (!metadata || typeof metadata !== "object") fail("Fresh artifact metadata is unavailable.");
  return metadata;
}
export function compilerConfiguration(artifact) {
  const metadata = metadataOf(artifact);
  const settings = metadata.settings;
  if (!settings || typeof settings !== "object") fail("Fresh artifact compiler settings are unavailable.");
  const compiler = {
    version: metadata.compiler?.version,
    optimizer: settings.optimizer?.enabled,
    optimizerRuns: String(settings.optimizer?.runs),
    evmVersion: settings.evmVersion,
    viaIR: settings.viaIR,
    metadataBytecodeHash: settings.metadata?.bytecodeHash,
    compilationTarget: settings.compilationTarget,
    remappings: [...(settings.remappings ?? [])].sort(),
    linkedLibraries: settings.libraries ?? {},
    materialSettings: settings,
  };
  if (typeof compiler.version !== "string" || !compiler.version.startsWith("0.8.24+") || compiler.optimizer !== true || compiler.optimizerRuns !== "200" || compiler.evmVersion !== "cancun" || compiler.viaIR !== true || typeof compiler.metadataBytecodeHash !== "string" || stableJson(compiler.compilationTarget) !== stableJson({ "src/WizPayMainnetV2.sol": "WizPayMainnetV2" }) || !Array.isArray(compiler.remappings)) fail("Fresh artifact compiler configuration does not match the audited deployment policy.");
  return Object.freeze(compiler);
}
export function compilerDigest(compiler) { return canonicalDigest(compiler); }
function artifactBytecode(artifact, field, label) {
  const raw = artifact?.[field]?.object;
  if (typeof raw !== "string") fail(`${label} is unavailable.`);
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]+$/.test(value) || value === "0x") fail(`${label} is unavailable.`);
  return value;
}
function materializeRuntimeBytecode(artifact, runtimeBytecode, canonicalUsdc) {
  const references = Object.values(artifact.deployedBytecode?.immutableReferences ?? {}).flat();
  if (references.length === 0) fail("Runtime immutable references are unavailable.");
  const word = canonicalUsdc.slice(2).toLowerCase().padStart(64, "0");
  const bytes = runtimeBytecode.slice(2).split("");
  for (const reference of references) {
    if (reference.length !== 32 || !Number.isSafeInteger(reference.start)) fail("Runtime immutable reference is invalid.");
    bytes.splice(reference.start * 2, reference.length * 2, ...word);
  }
  return `0x${bytes.join("")}`;
}
function sourceSetDigest(artifact) {
  const sources = metadataOf(artifact).sources;
  if (!sources || typeof sources !== "object" || !sources["src/WizPayMainnetV2.sol"]?.keccak256) fail("Fresh artifact source provenance is unavailable.");
  return canonicalDigest(Object.fromEntries(Object.entries(sources).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => [name, value.keccak256])));
}
export function encodePlanCore(core) {
  const identityDigest = keccak256(encodeAbiParameters(parseAbiParameters("uint256, uint256, string, uint256, string"), [BigInt(core.schemaVersion), BigInt(core.deploymentManifestSchemaVersion), core.network, BigInt(core.chainId), core.contract]));
  return encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, address, address, address, address, uint256, bytes32"), [identityDigest, core.sourceCommitDigest, core.sourceSetDigest, core.compilerDigest, core.creationBytecodeHash, core.runtimeBytecodeHash, core.initCodeHash, core.constructorDigest, core.canonicalUsdc, core.deployer, core.owner, core.feeRecipient, BigInt(core.feeBps), core.resourceManifestDigest]);
}
export function buildDeploymentPlan(rawInput, artifact, dependencies = {}) {
  const input = validateDeploymentInput(rawInput);
  if (!artifact || !Array.isArray(artifact.abi)) fail("A freshly compiled Foundry artifact is required.");
  if (!dependencies.resourceManifest) fail("The readable resource manifest is required; a caller-supplied digest is not accepted.");
  const currentCommit = String(dependencies.sourceCommit ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: dependencies.repositoryRoot ?? REPOSITORY_ROOT, encoding: "utf8" })).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(currentCommit) || currentCommit !== input.auditedCommit) fail("Current Git HEAD does not equal the explicitly audited commit.");
  const compiler = compilerConfiguration(artifact);
  const creationBytecode = artifactBytecode(artifact, "bytecode", "Creation bytecode");
  const runtimeTemplate = artifactBytecode(artifact, "deployedBytecode", "Runtime bytecode");
  const runtimeBytecode = materializeRuntimeBytecode(artifact, runtimeTemplate, input.canonicalUsdc);
  const args = [input.canonicalUsdc, input.owner, input.feeRecipient, BigInt(input.feeBps)];
  const initCode = encodeDeployData({ abi: artifact.abi, bytecode: creationBytecode, args });
  const core = {
    schemaVersion: PLAN_SCHEMA_VERSION, deploymentManifestSchemaVersion: DEPLOYMENT_MANIFEST_SCHEMA_VERSION, network: NETWORK, chainId: MAINNET_CHAIN_ID, contract: CONTRACT,
    sourceCommit: currentCommit, sourceCommitDigest: keccak256(toHex(currentCommit)), sourceSetDigest: sourceSetDigest(artifact), compiler, compilerDigest: compilerDigest(compiler), canonicalUsdc: input.canonicalUsdc, deployer: input.deployer, owner: input.owner, feeRecipient: input.feeRecipient, feeBps: input.feeBps,
    constructorArguments: { canonicalUsdc: args[0], initialOwner: args[1], feeRecipient: args[2], feeBps: input.feeBps },
    constructorDigest: keccak256(encodeAbiParameters(parseAbiParameters("address, address, address, uint256"), args)), creationBytecodeHash: keccak256(creationBytecode), runtimeBytecodeHash: keccak256(runtimeBytecode), initCodeHash: keccak256(initCode), initCode, resourceManifestDigest: resourceManifestDigest(dependencies.resourceManifest),
  };
  const planDigest = keccak256(encodePlanCore(core));
  let authorization;
  if (input.authorizationEvidencePath === null) {
    authorization = Object.freeze({ state: "unavailable", reason: "AUTHORIZATION_EVIDENCE_NOT_COMMITTED" });
  } else {
    const evidence = loadAuthorizationEvidence(input.authorizationEvidencePath, undefined, {
      repositoryRoot: dependencies.repositoryRoot,
      isGitTracked: dependencies.isGitTracked,
    });
    authorization = Object.freeze({ state: "authorized", recordPath: evidence.recordPath, recordDigest: evidence.digest });
  }
  return Object.freeze({ ...core, authorization, planDigest });
}
export function assertPlanDigest(plan) {
  const expected = bytes32(plan?.planDigest, "planDigest");
  if (keccak256(encodePlanCore(plan)) !== expected) fail("Deployment plan digest mismatch.");
  if (keccak256(plan.initCode) !== bytes32(plan.initCodeHash, "initCodeHash")) fail("Deployment init code hash mismatch.");
  return true;
}
export function assertPlanMatchesFreshInputs(plan, rawInput, artifact, dependencies) {
  const rebuilt = buildDeploymentPlan(rawInput, artifact, dependencies);
  if (rebuilt.planDigest !== plan.planDigest || stableJson({ ...rebuilt, authorization: undefined }) !== stableJson({ ...plan, authorization: undefined })) fail("Deployment plan does not match fresh readable inputs.");
  return true;
}
export function validateMainnetManifest(manifest) {
  exactKeys(manifest, ["schemaVersion", "network", "chainId", "status", "contract", "resourceManifestDigest", "deploymentPlanDigest", "deploymentResult"], "Mainnet manifest");
  if (manifest.schemaVersion !== DEPLOYMENT_MANIFEST_SCHEMA_VERSION || manifest.network !== NETWORK || manifest.chainId !== MAINNET_CHAIN_ID || manifest.contract !== CONTRACT) fail("Mainnet manifest identity is invalid.");
  if (manifest.status === "unavailable") {
    if (manifest.resourceManifestDigest !== null || manifest.deploymentPlanDigest !== null) fail("Unavailable manifest digests must be null.");
    if (Object.values(manifest.deploymentResult).some((value) => value !== null && value !== "unavailable")) fail("Unavailable manifest deployment result must remain empty.");
    return true;
  }
  if (manifest.status !== "deployed") fail("Mainnet manifest status must be unavailable or deployed.");
  bytes32(manifest.resourceManifestDigest, "resourceManifestDigest"); bytes32(manifest.deploymentPlanDigest, "deploymentPlanDigest"); return true;
}
async function cli() {
  const [command, inputPath, resourcePath, outputPath] = process.argv.slice(2);
  if (command === "validate-manifest" && inputPath && !resourcePath) { validateMainnetManifest(JSON.parse(await readFile(inputPath, "utf8"))); process.stdout.write("Mainnet manifest is valid.\n"); return; }
  if (command === "validate-input" && inputPath && !resourcePath) { validateDeploymentInput(JSON.parse(await readFile(inputPath, "utf8"))); process.stdout.write("Mainnet deployment input is valid.\n"); return; }
  if (command === "plan" && inputPath && resourcePath && outputPath) {
    const { buildFreshMainnetArtifact } = await import("./sync-mainnet-abi.mjs");
    const fresh = await buildFreshMainnetArtifact();
    try {
      const plan = buildDeploymentPlan(JSON.parse(await readFile(inputPath, "utf8")), fresh.artifact, { resourceManifest: JSON.parse(await readFile(resourcePath, "utf8")), sourceCommit: fresh.sourceCommit });
      await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" }); process.stdout.write(`${plan.planDigest}\n`);
    } finally { await rm(fresh.temporaryRoot, { recursive: true, force: true }); }
    return;
  }
  fail("Usage: validate-input <input.json> | validate-manifest <manifest.json> | plan <input.json> <resource-manifest.json> <new-output.json>");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cli().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
