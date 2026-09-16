import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
} from "viem";
import {
  assertPlanDigest,
  assertPlanMatchesFreshInputs,
  fail,
} from "./mainnet-deployment-plan.mjs";
import {
  createSafeEip1271Verifier,
  verifyAuthorizationEvidence,
} from "./mainnet-authorization-evidence.mjs";
import {
  resourceManifestDigest,
  stableJson,
  validateResourceManifest,
} from "./mainnet-resource-state.mjs";
import {
  createRpcClient,
  normalizeRpcUrl,
  quantity,
  rpcBlockTag,
} from "./mainnet-rpc.mjs";

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function canonicalUsdc() view returns (address)",
  "function feeCollector() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function paused() view returns (bool)",
]);
function check(condition, message) {
  if (!condition) fail(message);
}
function same(values, label) {
  const encoded = values.map((value) => stableJson(value));
  check(
    encoded.every((value) => value === encoded[0]),
    `RPC disagreement for ${label}.`,
  );
  return values[0];
}
async function call(client, address, functionName, blockTag) {
  const data = encodeFunctionData({ abi: ABI, functionName });
  return decodeFunctionResult({
    abi: ABI,
    functionName,
    data: await client.request("eth_call", [{ to: address, data }, blockTag]),
  });
}
function hash(value, label) {
  check(
    typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
    `${label} is invalid.`,
  );
  return value.toLowerCase();
}

export async function verifyMainnetDeployment(input, dependencies = {}) {
  const { plan: submittedPlan, manifest } = input;
  const transactionHash = hash(
    input.transactionHash,
    "Deployment transaction hash",
  );
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
    "Resource manifest does not reconcile with the plan.",
  );
  const requiredConfirmations =
    typeof input.requiredConfirmations === "string" &&
    /^[1-9]\d*$/.test(input.requiredConfirmations)
      ? BigInt(input.requiredConfirmations)
      : 0n;
  check(
    requiredConfirmations > 0n,
    "Required confirmations must be a positive integer.",
  );
  const officialUrls = manifest.resources.rpcEndpoints.map((resource) =>
    normalizeRpcUrl(resource.url),
  );
  const requestedUrls = (input.rpcUrls ?? []).map(normalizeRpcUrl);
  check(
    requestedUrls.length === 2 &&
      requestedUrls.every((url, index) => url === officialUrls[index]) &&
      new Set(officialUrls).size === 2,
    "Verifier RPC URLs must exactly match two distinct official records.",
  );
  const providers = manifest.resources.rpcEndpoints.map((resource) =>
    String(resource.providerIdentity ?? "")
      .trim()
      .toLowerCase(),
  );
  check(
    providers.every(Boolean) && new Set(providers).size === 2,
    "Verifier RPC provider identities must be distinct.",
  );
  const clients =
    dependencies.clients ?? officialUrls.map((url) => createRpcClient(url));
  check(
    clients.length === 2,
    "Post-deployment verification requires exactly two RPC clients.",
  );
  const chainIds = await Promise.all(
    clients.map(async (client) =>
      quantity(await client.request("eth_chainId"), "chain ID"),
    ),
  );
  check(
    same(chainIds.map(String), "chain ID") === "5042",
    "Post-deployment chain ID mismatch.",
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
  const receipts = await Promise.all(
    clients.map((client) =>
      client.request("eth_getTransactionReceipt", [transactionHash]),
    ),
  );
  const receipt = same(receipts, "deployment receipt");
  check(
    receipt && quantity(receipt.status, "receipt status") === 1n,
    "Deployment receipt reverted or is unavailable.",
  );
  const transactions = await Promise.all(
    clients.map((client) =>
      client.request("eth_getTransactionByHash", [transactionHash]),
    ),
  );
  const transaction = same(transactions, "deployment transaction");
  check(transaction, "Deployment transaction is unavailable.");
  check(
    hash(transaction.hash, "Returned transaction hash") === transactionHash &&
      hash(receipt.transactionHash, "Receipt transaction hash") ===
        transactionHash,
    "Requested, returned transaction, and receipt hashes differ.",
  );
  check(
    transaction.to === null && receipt.to === null,
    "Deployment transaction and receipt must have CREATE semantics.",
  );
  check(
    isAddressEqual(transaction.from, plan.deployer),
    "Deployment transaction sender mismatch.",
  );
  check(
    receipt.from &&
      isAddressEqual(receipt.from, transaction.from) &&
      hash(receipt.blockHash, "Receipt block hash") ===
        hash(transaction.blockHash, "Transaction block hash") &&
      quantity(receipt.blockNumber, "receipt block") ===
        quantity(transaction.blockNumber, "transaction block") &&
      quantity(receipt.transactionIndex, "receipt transaction index") ===
        quantity(transaction.transactionIndex, "transaction index"),
    "Receipt and transaction sender/block/hash evidence is inconsistent.",
  );
  check(
    (transaction.input ?? "").toLowerCase() === plan.initCode.toLowerCase() &&
      keccak256(transaction.input).toLowerCase() ===
        plan.initCodeHash.toLowerCase(),
    "Deployment init code does not match the plan.",
  );
  const expectedAddress = getContractAddress({
    from: plan.deployer,
    nonce: quantity(transaction.nonce, "deployment nonce"),
  });
  check(
    receipt.contractAddress &&
      isAddressEqual(receipt.contractAddress, expectedAddress),
    "CREATE-derived contract address does not match the receipt.",
  );
  if (input.deployedAddress)
    check(
      isAddressEqual(input.deployedAddress, expectedAddress),
      "Supplied deployed address mismatch.",
    );

  const latestBlocks = await Promise.all(
    clients.map((client) =>
      client.request("eth_getBlockByNumber", ["latest", false]),
    ),
  );
  const latestNumbers = latestBlocks.map((block) =>
    quantity(block.number, "latest block"),
  );
  check(
    latestNumbers.reduce((max, value) => (value > max ? value : max)) -
      latestNumbers.reduce((min, value) => (value < min ? value : min)) <=
      3n,
    "RPC latest blocks disagree.",
  );
  const nowSeconds = BigInt(
    Math.floor(new Date(dependencies.now ?? Date.now()).getTime() / 1000),
  );
  for (const block of latestBlocks) {
    const age =
      nowSeconds - quantity(block.timestamp, "latest block timestamp");
    check(age >= 0n && age <= 180n, "Latest block is stale or in the future.");
  }
  const receiptBlockNumber = quantity(receipt.blockNumber, "receipt block");
  for (const latest of latestNumbers)
    check(
      latest >= receiptBlockNumber,
      "Latest block is below the receipt block.",
    );
  const confirmations = latestNumbers.map(
    (latest) => latest - receiptBlockNumber + 1n,
  );
  check(
    confirmations.every((value) => value >= requiredConfirmations),
    "Deployment has insufficient confirmations.",
  );
  const blockTag = rpcBlockTag(receiptBlockNumber);
  const canonicalBlocks = await Promise.all(
    clients.map((client) =>
      client.request("eth_getBlockByNumber", [blockTag, false]),
    ),
  );
  check(
    canonicalBlocks.every(
      (block) =>
        hash(block.hash, "Canonical block hash") ===
        hash(receipt.blockHash, "Receipt block hash"),
    ),
    "Receipt block is not canonical on both RPCs.",
  );
  if ((dependencies.reorgDelayMs ?? 1_000) > 0)
    await new Promise((resolve) =>
      setTimeout(resolve, dependencies.reorgDelayMs ?? 1_000),
    );
  const stableBlocks = await Promise.all(
    clients.map((client) =>
      client.request("eth_getBlockByNumber", [blockTag, false]),
    ),
  );
  check(
    stableBlocks.every(
      (block) =>
        hash(block.hash, "Stable block hash") ===
        hash(receipt.blockHash, "Receipt block hash"),
    ),
    "Receipt block changed during the bounded reorg-stability check.",
  );

  const stateBlockNumber = latestNumbers.reduce((min, value) =>
    value < min ? value : min,
  );
  const stateTag = rpcBlockTag(stateBlockNumber);
  const stateBlocks = await Promise.all(
    clients.map((client) =>
      client.request("eth_getBlockByNumber", [stateTag, false]),
    ),
  );
  same(
    stateBlocks.map((block) => hash(block.hash, "State block hash")),
    "state snapshot block hash",
  );
  const codes = await Promise.all(
    clients.map((client) =>
      client.request("eth_getCode", [expectedAddress, stateTag]),
    ),
  );
  const code = same(codes, "runtime bytecode");
  check(
    code !== "0x" &&
      keccak256(code).toLowerCase() === plan.runtimeBytecodeHash.toLowerCase(),
    "Runtime bytecode hash mismatch.",
  );
  const values = {};
  for (const name of [
    "owner",
    "canonicalUsdc",
    "feeCollector",
    "feeBps",
    "paused",
  ])
    values[name] = same(
      await Promise.all(
        clients.map((client) => call(client, expectedAddress, name, stateTag)),
      ),
      name,
    );
  check(isAddressEqual(values.owner, plan.owner), "Deployed owner mismatch.");
  check(
    isAddressEqual(values.canonicalUsdc, plan.canonicalUsdc),
    "Deployed canonical USDC mismatch.",
  );
  check(
    isAddressEqual(values.feeCollector, plan.feeRecipient),
    "Deployed fee recipient mismatch.",
  );
  check(values.feeBps === BigInt(plan.feeBps), "Deployed fee rate mismatch.");
  check(values.paused === false, "Unexpected deployment pause state.");
  const output = {
    schemaVersion: 2,
    status: "verified",
    network: "arc-mainnet",
    chainId: 5042,
    transactionHash,
    blockNumber: receiptBlockNumber.toString(),
    blockHash: hash(receipt.blockHash, "Receipt block hash"),
    deployedAddress: getAddress(expectedAddress),
    deploymentSender: getAddress(transaction.from),
    confirmations: confirmations
      .reduce((min, value) => (value < min ? value : min))
      .toString(),
    initCodeHash: keccak256(transaction.input),
    runtimeBytecodeHash: keccak256(code),
    owner: getAddress(values.owner),
    canonicalUsdc: getAddress(values.canonicalUsdc),
    feeRecipient: getAddress(values.feeCollector),
    feeBps: values.feeBps.toString(),
    paused: false,
    deploymentPlanDigest: plan.planDigest,
    authorizationEvidenceDigest: authorization.recordDigest,
    resourceManifestDigest: plan.resourceManifestDigest,
    auditedSourceCommit: plan.sourceCommit,
    stateBlockNumber: stateBlockNumber.toString(),
    stateBlockHash: hash(stateBlocks[0].hash, "State block hash"),
  };
  return Object.freeze({
    ...output,
    outputDigest: keccak256(new TextEncoder().encode(stableJson(output))),
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined)
      fail("Verifier arguments must be --name value pairs.");
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}
async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const [plan, manifest, rawInput] = await Promise.all(
    [args.plan, args["resource-manifest"], args.input].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
  const rpcUrls = [args.rpc, args["rpc-secondary"]];
  const { buildFreshMainnetArtifact } = await import("./sync-mainnet-abi.mjs");
  const fresh = await buildFreshMainnetArtifact();
  try {
    const output = await verifyMainnetDeployment(
      {
        plan,
        manifest,
        rpcUrls,
        transactionHash: args.tx,
        deployedAddress: args.address,
        requiredConfirmations: args.confirmations ?? "12",
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
    process.stderr.write(
      `POST_DEPLOYMENT_VERIFICATION_FAILED: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
