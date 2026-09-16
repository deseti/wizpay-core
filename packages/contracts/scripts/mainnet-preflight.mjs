import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
} from "viem";
import {
  assertPlanDigest,
  assertPlanMatchesFreshInputs,
  fail,
  normalizeAddress,
} from "./mainnet-deployment-plan.mjs";
import {
  createSafeEip1271Verifier,
  verifyAuthorizationEvidence,
} from "./mainnet-authorization-evidence.mjs";
import {
  resourceManifestDigest,
  validateResourceManifest,
} from "./mainnet-resource-state.mjs";
import {
  createRpcClient,
  normalizeRpcUrl,
  quantity,
  rpcBlockTag,
} from "./mainnet-rpc.mjs";

const ERC20_READ_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MAX_GAS_PRICE = 1_000_000_000_000_000n;
const MAX_DEPLOY_GAS = 30_000_000n;

function check(condition, message) {
  if (!condition) fail(message);
}
function same(values, label) {
  const serialized = values.map((value) =>
    JSON.stringify(value, (_key, child) =>
      typeof child === "bigint" ? child.toString() : child,
    ),
  );
  check(
    serialized.every((value) => value === serialized[0]),
    `RPC disagreement for ${label}.`,
  );
  return values[0];
}
function relativeAgreement(values, label, maximumBps = 2_000n) {
  const min = values.reduce((a, b) => (a < b ? a : b));
  const max = values.reduce((a, b) => (a > b ? a : b));
  check(
    min > 0n && max <= min + (min * maximumBps) / 10_000n,
    `RPC disagreement or unreasonable value for ${label}.`,
  );
}
function hasPlaceholder(value) {
  if (typeof value === "string")
    return /(^|[^a-z])(unavailable|placeholder|replace[-_ ]?me|tbd|todo)([^a-z]|$)/i.test(
      value,
    );
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  return value && typeof value === "object"
    ? Object.values(value).some(hasPlaceholder)
    : false;
}
async function call(client, to, functionName, args, blockTag) {
  const data = encodeFunctionData({ abi: ERC20_READ_ABI, functionName, args });
  const result = await client.request("eth_call", [{ to, data }, blockTag]);
  return decodeFunctionResult({
    abi: ERC20_READ_ABI,
    functionName,
    data: result,
  });
}
async function sampleBlocks(
  client,
  { attempts = 3, sampleDelayMs = 1_000, now = Date.now() } = {},
) {
  const samples = [];
  for (let index = 0; index < attempts; index += 1) {
    const block = await client.request("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    check(
      block?.number && block?.timestamp && block?.hash,
      "Latest block response is incomplete.",
    );
    samples.push({
      number: quantity(block.number, "block number"),
      timestamp: quantity(block.timestamp, "block timestamp"),
      hash: block.hash.toLowerCase(),
    });
    if (samples.length >= 2 && samples.at(-1).number > samples[0].number) break;
    if (sampleDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, sampleDelayMs));
  }
  check(
    samples.at(-1).number > samples[0].number,
    "Chain is not advancing across a realistic bounded sample interval.",
  );
  const age =
    BigInt(Math.floor(new Date(now).getTime() / 1000)) -
    samples.at(-1).timestamp;
  check(
    age >= 0n && age <= 180n,
    "Latest block is stale or has an unreasonable future timestamp.",
  );
  return samples;
}

export async function runMainnetPreflight(input, dependencies = {}) {
  const { manifest, plan: submittedPlan } = input;
  validateResourceManifest(manifest, {
    requireOfficial: true,
    ...(dependencies.resourceValidation ?? {}),
  });
  const fresh = dependencies.planInputs;
  check(
    fresh?.rawInput && fresh?.artifact,
    "Fresh source and artifact inputs are required.",
  );
  const plan = assertPlanMatchesFreshInputs(
    submittedPlan,
    fresh.rawInput,
    fresh.artifact,
    {
      resourceManifest: manifest,
      sourceCommit: fresh.sourceCommit,
      repositoryRoot: fresh.repositoryRoot,
      isGitTracked: fresh.isGitTracked,
    },
  );
  assertPlanDigest(plan);
  check(
    resourceManifestDigest(manifest) === plan.resourceManifestDigest,
    "Resource manifest digest mismatch.",
  );
  check(
    plan.chainId === 5042 &&
      input.expectedChainId === 5042 &&
      plan.network === "arc-mainnet",
    "Expected deployment identity is not Arc Mainnet 5042.",
  );
  check(
    normalizeAddress(input.deployer, "deployer") === plan.deployer,
    "Deployer does not match the plan.",
  );
  check(
    normalizeAddress(input.owner, "owner") === plan.owner,
    "Owner does not match the plan.",
  );
  check(
    normalizeAddress(input.feeRecipient, "feeRecipient") === plan.feeRecipient,
    "Fee recipient does not match the plan.",
  );
  check(
    String(input.feeBps) === plan.feeBps,
    "Fee rate does not match the plan.",
  );
  const { deploymentStatus: _deploymentStatus, ...deploymentResources } =
    manifest.resources;
  check(
    !hasPlaceholder({
      manifest: { ...manifest, resources: deploymentResources },
      plan,
    }),
    "Unresolved placeholder found.",
  );
  const rpcResources = manifest.resources.rpcEndpoints;
  const officialUrls = rpcResources.map((resource) =>
    normalizeRpcUrl(resource.url),
  );
  const requestedUrls = (input.rpcUrls ?? []).map(normalizeRpcUrl);
  check(
    requestedUrls.length === 2,
    "Both CLI RPC URLs must be supplied in manifest order.",
  );
  check(
    requestedUrls.every((url, index) => url === officialUrls[index]),
    "CLI RPC URLs do not exactly match verified official records.",
  );
  check(
    new Set(officialUrls).size === 2,
    "RPC URLs must be distinct canonical endpoints.",
  );
  const providerIdentities = rpcResources.map((resource) =>
    String(resource.providerIdentity ?? "")
      .trim()
      .toLowerCase(),
  );
  check(
    providerIdentities.every(Boolean) && new Set(providerIdentities).size === 2,
    "RPC provider identities must be explicit and distinct; organizational independence still requires human source review.",
  );
  const clients =
    dependencies.clients ?? officialUrls.map((url) => createRpcClient(url));
  check(clients.length === 2, "Exactly two verified RPC clients are required.");
  const chainIds = await Promise.all(
    clients.map(async (client) =>
      Number(quantity(await client.request("eth_chainId"), "chain ID")),
    ),
  );
  check(
    same(chainIds, "chain ID") === 5042,
    "RPC chain ID is not Arc Mainnet 5042.",
  );
  const authorizationOptions = dependencies.authorizationValidation ?? {};
  const authorization = await verifyAuthorizationEvidence(
    plan,
    plan.authorization,
    {
      ...authorizationOptions,
      verifySafeSignature:
        authorizationOptions.verifySafeSignature ??
        createSafeEip1271Verifier(clients),
    },
  );
  const blockSamples = await Promise.all(
    clients.map((client) => sampleBlocks(client, dependencies.blockSampling)),
  );
  const tips = blockSamples.map((samples) => samples.at(-1).number);
  check(
    tips.reduce((max, value) => (value > max ? value : max)) -
      tips.reduce((min, value) => (value < min ? value : min)) <=
      3n,
    "RPC recent block ranges disagree.",
  );
  const snapshotNumber = tips.reduce((min, value) =>
    value < min ? value : min,
  );
  const blockTag = rpcBlockTag(snapshotNumber);
  const snapshotBlocks = await Promise.all(
    clients.map((client) =>
      client.request("eth_getBlockByNumber", [blockTag, false]),
    ),
  );
  const snapshotHash = same(
    snapshotBlocks.map((block) => block?.hash?.toLowerCase()),
    "snapshot block hash",
  );
  check(
    /^0x[0-9a-f]{64}$/.test(snapshotHash ?? ""),
    "Coherent snapshot block hash is unavailable.",
  );

  const usdc = getAddress(manifest.resources.canonicalUsdc.address);
  const codes = await Promise.all(
    clients.map((client) => client.request("eth_getCode", [usdc, blockTag])),
  );
  check(
    codes.every((code) => code !== "0x"),
    "Canonical USDC has no bytecode.",
  );
  const agreedCodeHash = same(
    codes.map(keccak256),
    "canonical USDC code identity",
  );
  check(
    agreedCodeHash.toLowerCase() ===
      manifest.resources.canonicalUsdc.codeHash.toLowerCase(),
    "Canonical USDC code hash mismatch.",
  );
  const readArgs = {
    name: [],
    symbol: [],
    decimals: [],
    totalSupply: [],
    balanceOf: [plan.deployer],
    allowance: [plan.deployer, plan.owner],
  };
  const reads = {};
  for (const name of Object.keys(readArgs))
    reads[name] = same(
      await Promise.all(
        clients.map((client) =>
          call(client, usdc, name, readArgs[name], blockTag),
        ),
      ),
      `USDC ${name}`,
    );
  check(
    reads.name === manifest.resources.canonicalUsdc.name &&
      reads.symbol === manifest.resources.canonicalUsdc.symbol &&
      Number(reads.decimals) === 6,
    "Canonical USDC metadata mismatch.",
  );
  check(
    typeof reads.totalSupply === "bigint" &&
      typeof reads.balanceOf === "bigint" &&
      typeof reads.allowance === "bigint",
    "Standard ERC-20 reads failed.",
  );

  check(
    manifest.resources.canonicalUsdc.proxyType === "eip1967" &&
      /^0x[0-9a-fA-F]{40}$/.test(
        manifest.resources.canonicalUsdc.implementationAddress ?? "",
      ) &&
      /^0x[0-9a-fA-F]{64}$/.test(
        manifest.resources.canonicalUsdc.implementationCodeHash ?? "",
      ),
    "Upgradeable canonical USDC requires authoritative proxy implementation identity.",
  );
  const slots = await Promise.all(
    clients.map((client) =>
      client.request("eth_getStorageAt", [
        usdc,
        EIP1967_IMPLEMENTATION_SLOT,
        blockTag,
      ]),
    ),
  );
  const implementation = getAddress(
    `0x${same(slots, "USDC proxy implementation").slice(-40)}`,
  );
  check(
    implementation ===
      getAddress(manifest.resources.canonicalUsdc.implementationAddress),
    "USDC proxy implementation address mismatch.",
  );
  const implementationCodes = await Promise.all(
    clients.map((client) =>
      client.request("eth_getCode", [implementation, blockTag]),
    ),
  );
  check(
    same(
      implementationCodes.map(keccak256),
      "USDC implementation code identity",
    ).toLowerCase() ===
      manifest.resources.canonicalUsdc.implementationCodeHash.toLowerCase(),
    "USDC proxy implementation code hash mismatch.",
  );

  const gasPrices = await Promise.all(
    clients.map(async (client) =>
      quantity(await client.request("eth_gasPrice"), "gas price"),
    ),
  );
  const gasEstimates = await Promise.all(
    clients.map(async (client) =>
      quantity(
        await client.request("eth_estimateGas", [
          { from: plan.deployer, data: plan.initCode },
          blockTag,
        ]),
        "gas estimate",
      ),
    ),
  );
  const baseFees = snapshotBlocks.map((block) =>
    quantity(block.baseFeePerGas, "base fee"),
  );
  for (let index = 0; index < clients.length; index += 1)
    check(
      gasPrices[index] > 0n &&
        gasPrices[index] <= MAX_GAS_PRICE &&
        gasPrices[index] >= baseFees[index] &&
        gasEstimates[index] > 0n &&
        gasEstimates[index] <= MAX_DEPLOY_GAS,
      "RPC returned zero or unreasonable fee/gas data.",
    );
  relativeAgreement(gasPrices, "gas price");
  relativeAgreement(gasEstimates, "gas estimate");
  same(baseFees.map(String), "base fee");
  await Promise.all(
    clients.map((client) =>
      client.request("eth_call", [
        { from: plan.deployer, data: plan.initCode },
        blockTag,
      ]),
    ),
  );
  const balances = await Promise.all(
    clients.map(async (client) =>
      quantity(
        await client.request("eth_getBalance", [plan.deployer, blockTag]),
        "deployer balance",
      ),
    ),
  );
  const nonces = await Promise.all(
    clients.map(async (client) =>
      quantity(
        await client.request("eth_getTransactionCount", [
          plan.deployer,
          "pending",
        ]),
        "deployer nonce",
      ),
    ),
  );
  same(nonces.map(String), "deployer nonce");
  same(balances.map(String), "deployer balance");
  for (let index = 0; index < clients.length; index += 1)
    check(
      balances[index] >= gasPrices[index] * gasEstimates[index] * 2n,
      "Deployer native balance is below the conservative gas threshold.",
    );
  return Object.freeze({
    ok: true,
    network: plan.network,
    chainId: 5042,
    planDigest: plan.planDigest,
    authorizationEvidenceDigest: authorization.recordDigest,
    resourceManifestDigest: plan.resourceManifestDigest,
    rpcCount: 2,
    snapshotBlockNumber: snapshotNumber.toString(),
    snapshotBlockHash: snapshotHash,
    deployerNonce: String(nonces[0]),
    checkedAt: dependencies.now ?? new Date().toISOString(),
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined)
      fail("Preflight arguments must be --name value pairs.");
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}
async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    await readFile(args["resource-manifest"], "utf8"),
  );
  const plan = JSON.parse(await readFile(args.plan, "utf8"));
  const rawInput = JSON.parse(await readFile(args.input, "utf8"));
  const rpcUrls = [args.rpc, args["rpc-secondary"]];
  const { buildFreshMainnetArtifact } = await import("./sync-mainnet-abi.mjs");
  const fresh = await buildFreshMainnetArtifact();
  try {
    const output = await runMainnetPreflight(
      {
        manifest,
        plan,
        rpcUrls,
        expectedChainId: Number(args["expected-chain-id"]),
        deployer: args.deployer,
        owner: args.owner,
        feeRecipient: args["fee-recipient"],
        feeBps: args["fee-bps"],
      },
      {
        clients: rpcUrls.map((url) => createRpcClient(url)),
        planInputs: {
          rawInput,
          artifact: fresh.artifact,
          sourceCommit: fresh.sourceCommit,
        },
      },
    );
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await rm(fresh.temporaryRoot, { recursive: true, force: true });
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  cli().catch((error) => {
    process.stderr.write(`PREFLIGHT_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
