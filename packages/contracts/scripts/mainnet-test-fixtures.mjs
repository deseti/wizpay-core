import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { buildDeploymentPlan } from "./mainnet-deployment-plan.mjs";
import { canonicalDigest, stableJson } from "./mainnet-resource-state.mjs";

const artifact = {
  abi: [{ type: "constructor", inputs: [{ name: "_canonicalUsdc", type: "address" }, { name: "initialOwner", type: "address" }, { name: "_feeCollector", type: "address" }, { name: "_feeBps", type: "uint256" }] }],
  bytecode: { object: "0x60006000556001600055" },
  deployedBytecode: { object: `0x${"00".repeat(64)}`, immutableReferences: { "1": [{ start: 16, length: 32 }] } },
  metadata: { compiler: { version: "0.8.24+commit.e11b9ed9" }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true, metadata: { bytecodeHash: "ipfs" }, compilationTarget: { "src/WizPayMainnetV2.sol": "WizPayMainnetV2" }, remappings: ["forge-std/=lib/forge-std/src/"], libraries: {} }, sources: { "src/WizPayMainnetV2.sol": { keccak256: `0x${"12".repeat(32)}` } } },
};
const base = { schemaVersion: 3, deploymentManifestSchemaVersion: 2, network: "arc-mainnet", chainId: 5042, contract: "WizPayMainnetV2", canonicalUsdc: "0x3600000000000000000000000000000000000000", owner: "0x12345678901234567890123456789012345689ab", feeRecipient: "0x1234567890123456789012345678901234569abc", feeBps: "10", deployer: "0x123456789012345678901234567890123456abcd", auditedCommit: "2ce70d17d9e5ecd142122b0fec6e01506d92b08a", authorizationEvidencePath: null };

export const proxyCode = "0x60006000";
export const implementationCode = "0x60016001";
export const implementationAddress = "0x6000000000000000000000000000000000000006";

export async function authorizedFixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "wizpay-mainnet-fixture-"));
  const resourceDirectory = "packages/contracts/deployments/authoritative-records/fixtures";
  const authorizationDirectory = "packages/contracts/deployments/authorization-records/fixtures";
  await mkdir(join(repositoryRoot, resourceDirectory), { recursive: true });
  await mkdir(join(repositoryRoot, authorizationDirectory), { recursive: true });
  const rawResources = {
    chainId: { value: 5042 },
    "rpcEndpoints[0]": { url: "https://rpc-a.invalid/", providerIdentity: "provider-a" },
    "rpcEndpoints[1]": { url: "https://rpc-b.invalid/", providerIdentity: "provider-b" },
    explorerUrl: { baseUrl: "https://explorer.invalid" },
    canonicalUsdc: { address: base.canonicalUsdc, name: "USD Coin", symbol: "USDC", decimals: 6, codeHash: keccak256(proxyCode), proxyType: "eip1967", implementationAddress, implementationCodeHash: keccak256(implementationCode) },
    nativeGas: { symbol: "USDC", decimals: 18 },
    erc20UsdcDecimals: { value: 6 },
    circleBlockchainIdentifier: { value: "ARC-FIXTURE" },
  };
  const officials = {};
  for (const [type, value] of Object.entries(rawResources)) {
    const record = { schemaVersion: 1, recordType: "arc-mainnet-authoritative-resource", fixtureOnly: true, authority: type === "canonicalUsdc" || type === "circleBlockchainIdentifier" ? "Circle" : "Arc", network: { name: "Circle Arc Mainnet", key: "arc-mainnet", chainId: "5042" }, resource: { type, value }, publication: { reference: `TEST_FIXTURE_${type}`, publishedAt: "2026-09-14T00:00:00.000Z", releaseId: null } };
    const file = `${type.replace(/[^a-z0-9]/gi, "-")}.json`;
    const recordPath = `${resourceDirectory}/${file}`;
    await writeFile(join(repositoryRoot, recordPath), `${JSON.stringify(record)}\n`);
    officials[type] = { state: "official", ...value, authoritativeSource: { recordPath, recordDigest: canonicalDigest(record), authority: record.authority, reference: record.publication.reference } };
  }
  const manifest = {
    schemaVersion: 1, network: "arc-mainnet",
    resources: { chainId: officials.chainId, rpcEndpoints: [officials["rpcEndpoints[0]"], officials["rpcEndpoints[1]"]], explorerUrl: officials.explorerUrl, canonicalUsdc: officials.canonicalUsdc, nativeGas: officials.nativeGas, erc20UsdcDecimals: officials.erc20UsdcDecimals, circleBlockchainIdentifier: officials.circleBlockchainIdentifier, deploymentStatus: { state: "unavailable", reason: "WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED" } },
    capabilities: { directSend: false, sameTokenUsdcPayroll: false, invoice: false, paymentLink: false, receiptVerification: false, executionIntentDurability: false, uniswapSwap: false, crossTokenPayroll: false, stableFx: false, xyloNet: false, cctp: false, gateway: false, bridge: false },
  };
  const authorizationEvidencePath = `${authorizationDirectory}/release.json`;
  const unsignedPlan = buildDeploymentPlan(base, artifact, { resourceManifest: manifest, sourceCommit: base.auditedCommit });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const releaseId = "release-8a-fixture";
  const payload = { planDigest: unsignedPlan.planDigest, chainId: "5042", creationBytecodeHash: unsignedPlan.creationBytecodeHash, runtimeBytecodeHash: unsignedPlan.runtimeBytecodeHash, deployer: unsignedPlan.deployer, finalSafeOwner: unsignedPlan.owner, feeRecipient: unsignedPlan.feeRecipient, feeBps: unsignedPlan.feeBps, resourceManifestDigest: unsignedPlan.resourceManifestDigest, releaseId };
  const authorization = { schemaVersion: 1, recordType: "wizpay-mainnet-deployment-authorization", fixtureOnly: true, method: "ed25519-test-fixture-v1", releaseId, createdAt: "2026-09-14T00:00:00.000Z", expiresAt: "2026-09-16T00:00:00.000Z", safe: unsignedPlan.owner, signer: unsignedPlan.owner, publicKey: publicKey.export({ type: "spki", format: "pem" }), payload, signature: sign(null, Buffer.from(stableJson(payload)), privateKey).toString("base64") };
  await writeFile(join(repositoryRoot, authorizationEvidencePath), `${JSON.stringify(authorization)}\n`);
  const rawInput = { ...base, authorizationEvidencePath };
  const plan = buildDeploymentPlan(rawInput, artifact, {
    resourceManifest: manifest,
    sourceCommit: base.auditedCommit,
    repositoryRoot,
    isGitTracked: () => true,
  });
  return {
    repositoryRoot, manifest, plan, rawInput, artifact,
    resourceValidation: { repositoryRoot, allowTestFixtures: true, isGitTracked: () => true },
    authorizationValidation: { repositoryRoot, allowTestFixtures: true, isGitTracked: () => true, now: "2026-09-15T00:00:00.000Z" },
    planInputs: { rawInput, artifact, sourceCommit: base.auditedCommit, repositoryRoot, isGitTracked: () => true },
  };
}
