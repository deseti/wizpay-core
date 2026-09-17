import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
} from "viem";
import { canonicalDigest, exactKeys, fail } from "./mainnet-resource-state.mjs";

export const ARC_MAINNET_UNISWAP_V4_POOL_EVIDENCE_PATH = fileURLToPath(
  new URL(
    "../deployments/resource-evidence/arc-mainnet-uniswap-v4-usdc-eurc.candidate.json",
    import.meta.url,
  ),
);

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "evidenceType",
  "status",
  "observedAt",
  "authoritativeSources",
  "network",
  "tokens",
  "contracts",
  "pinnedBlock",
  "rpcEvidence",
  "eventScan",
  "candidates",
  "directSwapEvidence",
  "conclusions",
  "canonicalEvidenceDigest",
];
const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
];
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const UNIVERSAL_ROUTER = "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const POOL_ID =
  "0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae";

export function derivePoolId(poolKey) {
  return keccak256(
    encodeAbiParameters(
      [{ name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS }],
      [poolKey],
    ),
  );
}

export function evidenceDigest(evidence) {
  const { canonicalEvidenceDigest: _digest, ...canonicalEvidence } = evidence;
  return canonicalDigest(canonicalEvidence);
}

function assertDecimal(value, label, { positive = false } = {}) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    fail(`${label} must be a canonical decimal string.`);
  }
  if (positive && BigInt(value) === 0n) fail(`${label} must be positive.`);
}

function validateEndpointIdentity(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9.-]+$/.test(value) ||
    value.includes("@") ||
    value.includes("?")
  ) {
    fail(`${label} must be a credential-free hostname.`);
  }
}

function validateQuote(quote, label) {
  exactKeys(quote, ["status", "amountIn", "amountOut", "gasEstimate"], label);
  if (quote.status !== "success")
    fail(`${label} must be a successful pinned read-only quote.`);
  assertDecimal(quote.amountIn, `${label}.amountIn`, { positive: true });
  assertDecimal(quote.amountOut, `${label}.amountOut`, { positive: true });
  assertDecimal(quote.gasEstimate, `${label}.gasEstimate`, { positive: true });
}

export function validateMainnetUniswapV4PoolEvidence(evidence) {
  exactKeys(evidence, TOP_LEVEL_KEYS, "Pool evidence");
  if (
    evidence.schemaVersion !== 1 ||
    evidence.evidenceType !== "arc-mainnet-uniswap-v4-pool-candidate" ||
    evidence.status !== "candidate-non-executable"
  ) {
    fail("Pool evidence must remain candidate-only and non-executable.");
  }
  if (
    typeof evidence.observedAt !== "string" ||
    Number.isNaN(Date.parse(evidence.observedAt))
  ) {
    fail("Pool evidence observation timestamp is invalid.");
  }
  const completedRangeCounts = Object.values(
    evidence.eventScan.completedRangeCount ?? {},
  );
  const scanComplete =
    completedRangeCounts.length >= 2 &&
    completedRangeCounts.every(
      (count) => count === evidence.eventScan.configuredRangeCount,
    );
  if (evidence.eventScan.uniquenessResolved !== scanComplete) {
    fail("Pool uniqueness conclusion does not match scan completion.");
  }
  if (
    !Array.isArray(evidence.authoritativeSources) ||
    evidence.authoritativeSources.length < 6
  ) {
    fail("Pool evidence requires primary authoritative sources.");
  }
  for (const [index, source] of evidence.authoritativeSources.entries()) {
    if (typeof source !== "string" || !source.startsWith("https://")) {
      fail(`authoritativeSources[${index}] must be an HTTPS URL.`);
    }
  }
  if (
    evidence.network?.key !== "arc-mainnet" ||
    evidence.network?.chainId !== 5_042 ||
    evidence.network?.name !== "Arc Mainnet"
  ) {
    fail("Pool evidence has the wrong Arc Mainnet identity.");
  }
  if (
    evidence.tokens?.USDC?.decimals !== 6 ||
    evidence.tokens?.EURC?.decimals !== 6 ||
    !isAddressEqual(evidence.tokens.USDC.address, USDC) ||
    !isAddressEqual(evidence.tokens.EURC.address, EURC)
  ) {
    fail("Pool evidence has the wrong official token identity.");
  }
  if (
    !isAddressEqual(evidence.contracts?.poolManager?.address, POOL_MANAGER) ||
    !isAddressEqual(evidence.contracts?.stateView?.address, STATE_VIEW) ||
    !isAddressEqual(evidence.contracts?.quoter?.address, QUOTER) ||
    !isAddressEqual(
      evidence.contracts?.universalRouter?.address,
      UNIVERSAL_ROUTER,
    ) ||
    !isAddressEqual(evidence.contracts?.permit2?.address, PERMIT2)
  ) {
    fail("Pool evidence has an incorrect official contract identity.");
  }
  if (
    !Number.isSafeInteger(evidence.pinnedBlock?.number) ||
    evidence.pinnedBlock.number <= 0 ||
    !/^0x[0-9a-f]{64}$/.test(evidence.pinnedBlock.hash)
  ) {
    fail("Pool evidence pinned block is invalid.");
  }
  if (!Array.isArray(evidence.rpcEvidence) || evidence.rpcEvidence.length < 2) {
    fail("Pool evidence requires an independent RPC quorum.");
  }
  const rpcHosts = new Set();
  for (const [index, observation] of evidence.rpcEvidence.entries()) {
    validateEndpointIdentity(
      observation.endpointIdentity,
      `rpcEvidence[${index}].endpointIdentity`,
    );
    if (
      observation.chainId !== 5_042 ||
      observation.pinnedBlockNumber !== evidence.pinnedBlock.number ||
      observation.pinnedBlockHash !== evidence.pinnedBlock.hash
    ) {
      fail(
        `rpcEvidence[${index}] does not agree on the pinned Arc Mainnet block.`,
      );
    }
    rpcHosts.add(observation.endpointIdentity);
  }
  if (rpcHosts.size !== evidence.rpcEvidence.length)
    fail("RPC evidence endpoints must be independent identities.");
  if (
    evidence.eventScan?.fromBlock !==
      evidence.contracts.poolManager.deploymentBlock ||
    evidence.eventScan?.toBlock !== evidence.pinnedBlock.number ||
    evidence.eventScan?.failedRangeCount !== 0 ||
    !Array.isArray(evidence.eventScan?.independentlyScannedBy) ||
    evidence.eventScan.independentlyScannedBy.length < 2
  ) {
    fail(
      "Initialize event scan coverage or independent verification is incomplete.",
    );
  }
  for (const [
    index,
    endpoint,
  ] of evidence.eventScan.independentlyScannedBy.entries()) {
    validateEndpointIdentity(
      endpoint,
      `eventScan.independentlyScannedBy[${index}]`,
    );
  }
  if (
    !Array.isArray(evidence.candidates) ||
    evidence.candidates.length === 0 ||
    evidence.eventScan.candidateCount !== evidence.candidates.length
  ) {
    fail("Initialize event candidate count is inconsistent.");
  }
  for (const [index, candidate] of evidence.candidates.entries()) {
    const label = `candidates[${index}]`;
    if (
      !Number.isSafeInteger(candidate.initializationBlock) ||
      candidate.initializationBlock < evidence.eventScan.fromBlock ||
      candidate.initializationBlock > evidence.pinnedBlock.number ||
      !/^0x[0-9a-f]{64}$/.test(candidate.initializationBlockHash) ||
      !/^0x[0-9a-f]{64}$/.test(candidate.transactionHash)
    ) {
      fail(`${label} initialization evidence is invalid.`);
    }
    if (
      !isAddressEqual(candidate.poolKey.currency0, USDC) ||
      !isAddressEqual(candidate.poolKey.currency1, EURC) ||
      getAddress(candidate.poolKey.currency0) !== USDC ||
      getAddress(candidate.poolKey.currency1) !== EURC
    ) {
      fail(`${label} has the wrong canonical token ordering.`);
    }
    const derived = derivePoolId(candidate.poolKey);
    if (
      candidate.poolIdMatches !== true ||
      candidate.emittedPoolId !== derived ||
      candidate.recomputedPoolId !== derived
    ) {
      fail(`${label} emitted and recomputed PoolIds do not match.`);
    }
    assertDecimal(
      candidate.initialize.sqrtPriceX96,
      `${label}.initialize.sqrtPriceX96`,
      { positive: true },
    );
    assertDecimal(
      candidate.stateView.sqrtPriceX96,
      `${label}.stateView.sqrtPriceX96`,
      { positive: true },
    );
    assertDecimal(
      candidate.stateView.liquidity,
      `${label}.stateView.liquidity`,
    );
    if (candidate.stateView.initialized !== true)
      fail(`${label} is not initialized at the pinned block.`);
    if (BigInt(candidate.stateView.liquidity) > 0n) {
      validateQuote(
        candidate.quotes.USDC_TO_EURC,
        `${label}.quotes.USDC_TO_EURC`,
      );
      validateQuote(
        candidate.quotes.EURC_TO_USDC,
        `${label}.quotes.EURC_TO_USDC`,
      );
    }
  }
  if (
    !Array.isArray(evidence.directSwapEvidence) ||
    evidence.directSwapEvidence.length !== 2
  ) {
    fail("Pool evidence requires both direct swap directions.");
  }
  const directions = new Set();
  for (const [index, swap] of evidence.directSwapEvidence.entries()) {
    const label = `directSwapEvidence[${index}]`;
    exactKeys(
      swap,
      [
        "direction",
        "transactionHash",
        "blockNumber",
        "status",
        "wallet",
        "recipient",
        "router",
        "poolManager",
        "poolId",
        "commands",
        "actions",
        "amountIn",
        "amountOut",
        "nativeValue",
      ],
      label,
    );
    if (
      (swap.direction !== "USDC_TO_EURC" &&
        swap.direction !== "EURC_TO_USDC") ||
      directions.has(swap.direction) ||
      !/^0x[0-9a-f]{64}$/.test(swap.transactionHash) ||
      !Number.isSafeInteger(swap.blockNumber) ||
      swap.blockNumber <= evidence.pinnedBlock.number ||
      swap.status !== "success" ||
      !isAddressEqual(swap.wallet, swap.recipient) ||
      !isAddressEqual(swap.router, UNIVERSAL_ROUTER) ||
      !isAddressEqual(swap.poolManager, POOL_MANAGER) ||
      swap.poolId !== POOL_ID ||
      swap.actions !== "0x070b0e"
    ) {
      fail(`${label} does not match the locked direct-swap evidence.`);
    }
    assertDecimal(swap.amountIn, `${label}.amountIn`, { positive: true });
    assertDecimal(swap.amountOut, `${label}.amountOut`, { positive: true });
    assertDecimal(swap.nativeValue, `${label}.nativeValue`);
    if (
      (swap.direction === "USDC_TO_EURC" &&
        (swap.commands !== "0x10" ||
          BigInt(swap.nativeValue) !== BigInt(swap.amountIn) * 10n ** 12n)) ||
      (swap.direction === "EURC_TO_USDC" &&
        (swap.commands !== "0x0a10" || swap.nativeValue !== "0"))
    ) {
      fail(`${label} has incorrect native or Permit2 handling.`);
    }
    directions.add(swap.direction);
  }
  if (
    evidence.conclusions?.poolKeySafeToAdopt !== false ||
    evidence.conclusions?.poolIdSafeToAdopt !== false ||
    evidence.conclusions?.quoteCalldataImplementationMayBegin !== true ||
    evidence.conclusions?.executable !== false ||
    evidence.conclusions?.bidirectionalDirectSwapsVerified !== true ||
    !Array.isArray(evidence.conclusions?.unresolvedRequirements) ||
    !evidence.conclusions.unresolvedRequirements.includes(
      "GIT_TRACKING_REQUIREMENT_UNSATISFIED",
    ) ||
    !evidence.conclusions.unresolvedRequirements.includes(
      "POOL_UNIQUENESS_SCAN_INCOMPLETE",
    ) ||
    !evidence.conclusions.unresolvedRequirements.includes(
      "EXECUTION_AUTHORIZATION_UNAVAILABLE",
    )
  ) {
    fail(
      "Pool evidence conclusions must preserve candidate-only identity and fail closed.",
    );
  }
  if (evidence.canonicalEvidenceDigest !== evidenceDigest(evidence)) {
    fail("Pool evidence canonical digest mismatch.");
  }
  return true;
}

export function loadMainnetUniswapV4PoolEvidence(
  path = ARC_MAINNET_UNISWAP_V4_POOL_EVIDENCE_PATH,
) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateMainnetUniswapV4PoolEvidence(loadMainnetUniswapV4PoolEvidence());
  process.stdout.write(
    "Arc Mainnet Uniswap V4 evidence remains candidate-only and non-executable.\n",
  );
}
