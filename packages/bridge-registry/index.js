"use strict";

const MAINNET_CHAIN_IDS = Object.freeze([1, 10, 137, 8453, 42161, 43114, 5042]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const BRIDGE_TESTNETS = deepFreeze([]);
const BRIDGE_TESTNET_BY_CODE = deepFreeze({});

function bridgeUnavailable() {
  throw new Error("Bridge is unavailable on Arc Mainnet.");
}

function getBridgeTestnet() {
  return bridgeUnavailable();
}

// ── Official Circle CCTP production registry ───────────────────────────────
// Arc Mainnet is a first-class CCTP route (domain 26, CCTP V2).
//
// Authoritative sources (verified September 2026):
// - Supported chains/domains + Fast availability per source:
//   https://developers.circle.com/cctp/concepts/supported-chains-and-domains
//   Arc: Standard ✅, Fast N/A (Standard already ~0.5s, no Fast needed).
//   Base/Ethereum/Arbitrum/OP: Standard ✅, Fast ✅.
//   Avalanche/Polygon: Standard ✅, Fast N/A (Standard already ~8s).
// - Production contract addresses (TokenMessengerV2, MessageTransmitterV2):
//   https://developers.circle.com/cctp/references/contract-addresses
// - Native USDC addresses:
//   https://developers.circle.com/stablecoins/usdc-contract-addresses
// - Arc CCTP contracts and domain 26:
//   https://docs.arc.io/arc/references/contract-addresses
// - Attestation API (production base https://iris-api.circle.com):
//   https://developers.circle.com/api-reference/cctp/all/get-messages-v2
// - Finality (Fast ≤1000: seconds; Standard ≥2000: Arc ~0.5s, Base ~15-19min):
//   https://developers.circle.com/cctp/concepts/finality-and-block-confirmations
// - Fast fees (Fast only, 0-13bps by source; Standard free) + fee API:
//   https://developers.circle.com/cctp/concepts/fees
// - Fast allowance (global, check before Fast burns):
//   https://developers.circle.com/cctp/concepts/fast-transfer-allowance
// - depositForBurn / receiveMessage semantics and $10M single-burn limit:
//   https://developers.circle.com/cctp/references/contract-interfaces

const CCTP_TOKEN_MESSENGER_V2 =
  "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const CCTP_MESSAGE_TRANSMITTER_V2 =
  "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

const CCTP_PRODUCTION = deepFreeze({
  version: "CCTP_V2",
  // Standard Transfer threshold (hard finality). Arc source settles ~0.5s.
  standardFinalityThreshold: 2000,
  // Fast Transfer threshold (soft finality, seconds). Only for sources where
  // Circle marks Fast available (Base/Ethereum/Arbitrum/OP/...). Arc is N/A.
  fastFinalityThreshold: 1000,
  // $10,000,000 USDC single-burn limit, in 6-decimal base units.
  maxBurnAmountUnits: "10000000000000",
  irisApiBaseUrl: "https://iris-api.circle.com",
  authoritativeSources: [
    "https://developers.circle.com/cctp/concepts/supported-chains-and-domains",
    "https://developers.circle.com/cctp/references/contract-addresses",
    "https://developers.circle.com/cctp/references/contract-interfaces",
    "https://developers.circle.com/stablecoins/usdc-contract-addresses",
    "https://developers.circle.com/api-reference/cctp/all/get-messages-v2",
    "https://developers.circle.com/cctp/concepts/finality-and-block-confirmations",
    "https://docs.arc.io/arc/references/contract-addresses",
  ],
});

const BRIDGE_CHAINS = deepFreeze([
  {
    code: "ARC-MAINNET",
    name: "Arc",
    chainId: 5042,
    domain: 26,
    usdcAddress: "0x3600000000000000000000000000000000000000",
    usdcDecimals: 6,
    tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
    messageTransmitterV2: CCTP_MESSAGE_TRANSMITTER_V2,
    explorerBaseUrl: "https://explorer.arc.io",
    // Circle marks Arc source Fast as N/A (Standard already ~0.5s).
    fastTransferSource: false,
  },
  {
    code: "ETH-MAINNET",
    name: "Ethereum",
    chainId: 1,
    domain: 0,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDecimals: 6,
    tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
    messageTransmitterV2: CCTP_MESSAGE_TRANSMITTER_V2,
    explorerBaseUrl: "https://etherscan.io",
    fastTransferSource: true,
  },
  {
    code: "BASE-MAINNET",
    name: "Base",
    chainId: 8453,
    domain: 6,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
    messageTransmitterV2: CCTP_MESSAGE_TRANSMITTER_V2,
    explorerBaseUrl: "https://basescan.org",
    fastTransferSource: true,
  },
  {
    code: "ARB-MAINNET",
    name: "Arbitrum",
    chainId: 42161,
    domain: 3,
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDecimals: 6,
    tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
    messageTransmitterV2: CCTP_MESSAGE_TRANSMITTER_V2,
    explorerBaseUrl: "https://arbiscan.io",
    fastTransferSource: true,
  },
  {
    code: "OP-MAINNET",
    name: "OP Mainnet",
    chainId: 10,
    domain: 2,
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usdcDecimals: 6,
    tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
    messageTransmitterV2: CCTP_MESSAGE_TRANSMITTER_V2,
    explorerBaseUrl: "https://optimistic.etherscan.io",
    fastTransferSource: true,
  },
  {
    code: "POLYGON-MAINNET",
    name: "Polygon PoS",
    chainId: 137,
    domain: 7,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdcDecimals: 6,
    tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
    messageTransmitterV2: CCTP_MESSAGE_TRANSMITTER_V2,
    explorerBaseUrl: "https://polygonscan.com",
    // Circle marks Polygon source Fast as N/A (Standard already ~8s).
    fastTransferSource: false,
  },
  {
    code: "AVAX-MAINNET",
    name: "Avalanche",
    chainId: 43114,
    domain: 1,
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    usdcDecimals: 6,
    tokenMessengerV2: CCTP_TOKEN_MESSENGER_V2,
    messageTransmitterV2: CCTP_MESSAGE_TRANSMITTER_V2,
    explorerBaseUrl: "https://snowtrace.io",
    // Circle marks Avalanche source Fast as N/A (Standard already ~8s).
    fastTransferSource: false,
  },
]);

const BRIDGE_CHAIN_BY_CODE = deepFreeze(
  Object.fromEntries(BRIDGE_CHAINS.map((chain) => [chain.code, chain])),
);

class BridgeRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeRegistryError";
    this.code = code;
  }
}

function assertEthAddress(value, label) {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value) ||
    /^0x0{40}$/.test(value)
  ) {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_INVALID_ADDRESS",
      `Bridge chain ${label} is not a valid EVM address.`,
    );
  }
  return value;
}

function validateBridgeChainEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_INVALID",
      "Bridge chain entry must be an object.",
    );
  }
  if (typeof entry.code !== "string" || !/^[A-Z0-9-]+$/.test(entry.code)) {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_INVALID",
      "Bridge chain code must be an uppercase mainnet identifier.",
    );
  }
  if (/TESTNET|SEPOLIA|AMOY|FUJI|DEVNET/i.test(entry.code)) {
    throw new BridgeRegistryError(
      "BRIDGE_TESTNET_FORBIDDEN",
      "Bridge testnet routes are not supported.",
    );
  }
  if (!Number.isSafeInteger(entry.chainId) || entry.chainId <= 0) {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_INVALID",
      `Bridge chain ${entry.code} has an invalid chain ID.`,
    );
  }
  if (!Number.isSafeInteger(entry.domain) || entry.domain < 0) {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_INVALID",
      `Bridge chain ${entry.code} has an invalid CCTP domain.`,
    );
  }
  assertEthAddress(entry.usdcAddress, `${entry.code} usdcAddress`);
  assertEthAddress(
    entry.tokenMessengerV2,
    `${entry.code} tokenMessengerV2`,
  );
  assertEthAddress(
    entry.messageTransmitterV2,
    `${entry.code} messageTransmitterV2`,
  );
  if (entry.usdcDecimals !== 6) {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_INVALID",
      `Bridge chain ${entry.code} must use 6-decimal native USDC.`,
    );
  }
  if (typeof entry.fastTransferSource !== "boolean") {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_INVALID",
      `Bridge chain ${entry.code} must declare fastTransferSource.`,
    );
  }
  return true;
}

function getBridgeChain(code) {
  const chain = BRIDGE_CHAIN_BY_CODE[code];
  if (!chain) {
    throw new BridgeRegistryError(
      "BRIDGE_CHAIN_UNKNOWN",
      `Unknown bridge chain: ${JSON.stringify(code)}. Bridge is available on Arc Mainnet CCTP routes only.`,
    );
  }
  return chain;
}

function listBridgeChains() {
  return BRIDGE_CHAINS;
}

// Transfer mode is a source-chain property per Circle's supported-chains
// table. Fast sources (Base/Ethereum/...) use minFinalityThreshold 1000;
// N/A sources (Arc/Avalanche/Polygon, already fast via Standard) use 2000.
// There is no user selector: new intents must use the authoritative mode.
function getBridgeTransferMode(sourceCode) {
  const source = getBridgeChain(sourceCode);
  return source.fastTransferSource ? "fast" : "standard";
}

function getBridgeFinalityThreshold(sourceCode) {
  return getBridgeTransferMode(sourceCode) === "fast"
    ? CCTP_PRODUCTION.fastFinalityThreshold
    : CCTP_PRODUCTION.standardFinalityThreshold;
}

// Every WizPay bridge route is Arc-centric: Arc Mainnet must be the source or
// the destination. Wallet signing stays self-custodial on both ends and the
// backend only persists lifecycle state, fetches attestations, and verifies
// receipts — it never signs user transactions.
function assertBridgeRoute(sourceCode, destinationCode) {
  const source = getBridgeChain(sourceCode);
  const destination = getBridgeChain(destinationCode);
  if (source.code === destination.code) {
    throw new BridgeRegistryError(
      "BRIDGE_ROUTE_SAME_CHAIN",
      "Bridge source and destination must be different blockchains.",
    );
  }
  if (source.code !== "ARC-MAINNET" && destination.code !== "ARC-MAINNET") {
    throw new BridgeRegistryError(
      "BRIDGE_ROUTE_NOT_ARC",
      "Bridge routes must include Arc Mainnet as source or destination.",
    );
  }
  return { source, destination };
}

function assertRegistryMatch(code, candidate) {
  const expected = getBridgeChain(code);
  validateBridgeChainEntry(candidate);
  for (const key of [
    "chainId",
    "domain",
    "usdcAddress",
    "tokenMessengerV2",
    "messageTransmitterV2",
  ]) {
    const left = String(candidate[key]).toLowerCase();
    const right = String(expected[key]).toLowerCase();
    if (left !== right) {
      throw new BridgeRegistryError(
        "BRIDGE_REGISTRY_MISMATCH",
        `Bridge registry mismatch for ${code} field ${key}.`,
      );
    }
  }
  return true;
}

function validateBridgeRegistry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new BridgeRegistryError(
      "BRIDGE_REGISTRY_EMPTY",
      "Bridge registry must include Arc Mainnet CCTP routes.",
    );
  }
  const codes = new Set();
  for (const entry of entries) {
    validateBridgeChainEntry(entry);
    if (codes.has(entry.code)) {
      throw new BridgeRegistryError(
        "BRIDGE_REGISTRY_DUPLICATE",
        `Duplicate bridge chain code: ${entry.code}.`,
      );
    }
    codes.add(entry.code);
  }
  if (!codes.has("ARC-MAINNET")) {
    throw new BridgeRegistryError(
      "BRIDGE_REGISTRY_MISSING_ARC",
      "Bridge registry must include ARC-MAINNET.",
    );
  }
  return true;
}

validateBridgeRegistry([...BRIDGE_CHAINS]);

module.exports = {
  BRIDGE_TESTNETS,
  BRIDGE_TESTNET_BY_CODE,
  MAINNET_CHAIN_IDS,
  BRIDGE_CHAINS,
  BRIDGE_CHAIN_BY_CODE,
  CCTP_PRODUCTION,
  BridgeRegistryError,
  assertBridgeRoute,
  assertRegistryMatch,
  getBridgeChain,
  getBridgeFinalityThreshold,
  getBridgeTransferMode,
  getBridgeTestnet,
  listBridgeChains,
  validateBridgeChainEntry,
  validateBridgeRegistry,
};
