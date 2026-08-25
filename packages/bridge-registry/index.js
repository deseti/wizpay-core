"use strict";

const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const CCTP_V2_TESTNET_IRIS_BASE_URL = "https://iris-api-sandbox.circle.com/v2";

const MAINNET_CHAIN_IDS = Object.freeze([1, 10, 143, 8453, 42161, 4663]);

const definitions = [
  {
    code: "ARC-TESTNET",
    name: "Arc Testnet",
    chainId: 5_042_002,
    cctpDomain: 26,
    usdcAddress: "0x3600000000000000000000000000000000000000",
    mintEvidenceEmitter: "0xfffffffffffffffffffffffffffffffffffffffe",
    mintEvidenceDecimals: 18,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    rpcEnvKey: "ARC_TESTNET_RPC_URL",
    browserRpcEnvKey: "NEXT_PUBLIC_ARC_TESTNET_RPC_URL",
    defaultRpcUrl: "https://rpc.testnet.arc.io",
    explorerBaseUrl: "https://testnet.arcscan.app",
    gasCurrency: "USDC",
    cctpVersion: 2,
    usdcDecimals: 6,
    standardTransferSource: true,
    fastTransferSource: false,
    finalityThreshold: 2000,
    nativeGasRequired: true,
    environment: "testnet",
    source: true,
    destination: true,
    testnet: true,
  },
  {
    code: "ETH-SEPOLIA",
    name: "Ethereum Sepolia",
    chainId: 11_155_111,
    cctpDomain: 0,
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    mintEvidenceEmitter: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    mintEvidenceDecimals: 6,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    rpcEnvKey: "ETHEREUM_SEPOLIA_RPC_URL",
    browserRpcEnvKey: "NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL",
    defaultRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerBaseUrl: "https://sepolia.etherscan.io",
    gasCurrency: "ETH",
    cctpVersion: 2,
    usdcDecimals: 6,
    standardTransferSource: true,
    fastTransferSource: true,
    finalityThreshold: 2000,
    nativeGasRequired: true,
    environment: "testnet",
    source: true,
    destination: true,
    testnet: true,
  },
  {
    code: "BASE-SEPOLIA",
    name: "Base Sepolia",
    chainId: 84_532,
    cctpDomain: 6,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    mintEvidenceEmitter: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    mintEvidenceDecimals: 6,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    rpcEnvKey: "BASE_SEPOLIA_RPC_URL",
    browserRpcEnvKey: "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
    defaultRpcUrl: "https://sepolia.base.org",
    explorerBaseUrl: "https://sepolia.basescan.org",
    gasCurrency: "ETH",
    cctpVersion: 2,
    usdcDecimals: 6,
    standardTransferSource: true,
    fastTransferSource: true,
    finalityThreshold: 2000,
    nativeGasRequired: true,
    environment: "testnet",
    source: true,
    destination: true,
    testnet: true,
  },
  {
    code: "ARB-SEPOLIA",
    name: "Arbitrum Sepolia",
    chainId: 421_614,
    cctpDomain: 3,
    usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    mintEvidenceEmitter: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    mintEvidenceDecimals: 6,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    rpcEnvKey: "ARBITRUM_SEPOLIA_RPC_URL",
    browserRpcEnvKey: "NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL",
    defaultRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerBaseUrl: "https://sepolia.arbiscan.io",
    gasCurrency: "ETH",
    cctpVersion: 2,
    usdcDecimals: 6,
    standardTransferSource: true,
    fastTransferSource: true,
    finalityThreshold: 2000,
    nativeGasRequired: true,
    environment: "testnet",
    source: true,
    destination: true,
    testnet: true,
  },
  {
    code: "OP-SEPOLIA",
    name: "OP Sepolia",
    chainId: 11_155_420,
    cctpDomain: 2,
    usdcAddress: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    mintEvidenceEmitter: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    mintEvidenceDecimals: 6,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    rpcEnvKey: "OP_SEPOLIA_RPC_URL",
    browserRpcEnvKey: "NEXT_PUBLIC_OP_SEPOLIA_RPC_URL",
    defaultRpcUrl: "https://sepolia.optimism.io",
    explorerBaseUrl: "https://testnet-explorer.optimism.io",
    gasCurrency: "ETH",
    cctpVersion: 2,
    usdcDecimals: 6,
    standardTransferSource: true,
    fastTransferSource: true,
    finalityThreshold: 2000,
    nativeGasRequired: true,
    environment: "testnet",
    source: true,
    destination: true,
    testnet: true,
  },
  {
    code: "MONAD-TESTNET",
    name: "Monad Testnet",
    chainId: 10_143,
    cctpDomain: 15,
    usdcAddress: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    mintEvidenceEmitter: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    mintEvidenceDecimals: 6,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    rpcEnvKey: "MONAD_TESTNET_RPC_URL",
    browserRpcEnvKey: "NEXT_PUBLIC_MONAD_TESTNET_RPC_URL",
    defaultRpcUrl: "https://testnet-rpc.monad.xyz",
    explorerBaseUrl: "https://testnet.monadvision.com",
    gasCurrency: "MON",
    cctpVersion: 2,
    usdcDecimals: 6,
    standardTransferSource: true,
    fastTransferSource: false,
    finalityThreshold: 2000,
    nativeGasRequired: true,
    environment: "testnet",
    source: true,
    destination: true,
    testnet: true,
  },
];

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizedAddress(value) {
  return value.toLowerCase();
}

function validateBridgeRegistry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Bridge registry must contain at least one testnet.");
  }

  const codes = new Set();
  const chainIds = new Set();
  const domains = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Bridge registry entries must be objects.");
    }
    if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(entry.code ?? "")) {
      throw new Error("Bridge registry contains a malformed network code.");
    }
    if (codes.has(entry.code)) {
      throw new Error(`Duplicate bridge network code: ${entry.code}.`);
    }
    if (!Number.isSafeInteger(entry.chainId) || entry.chainId <= 0) {
      throw new Error(`Invalid chain ID for ${entry.code}.`);
    }
    if (chainIds.has(entry.chainId)) {
      throw new Error(`Duplicate bridge chain ID: ${entry.chainId}.`);
    }
    if (MAINNET_CHAIN_IDS.includes(entry.chainId) || entry.testnet !== true) {
      throw new Error(
        `Mainnet or non-testnet registry entry rejected: ${entry.code}.`,
      );
    }
    if (!Number.isSafeInteger(entry.cctpDomain) || entry.cctpDomain < 0) {
      throw new Error(`Invalid CCTP domain for ${entry.code}.`);
    }
    if (domains.has(entry.cctpDomain)) {
      throw new Error(`Duplicate CCTP domain: ${entry.cctpDomain}.`);
    }
    if (
      !isAddress(entry.usdcAddress) ||
      !isAddress(entry.mintEvidenceEmitter) ||
      ![6, 18].includes(entry.mintEvidenceDecimals) ||
      !isAddress(entry.tokenMessengerV2) ||
      !isAddress(entry.messageTransmitterV2)
    ) {
      throw new Error(`Invalid contract address for ${entry.code}.`);
    }
    if (
      entry.cctpVersion !== 2 ||
      entry.usdcDecimals !== 6 ||
      entry.standardTransferSource !== true ||
      typeof entry.fastTransferSource !== "boolean" ||
      entry.finalityThreshold !== 2000 ||
      entry.nativeGasRequired !== true ||
      entry.environment !== "testnet"
    ) {
      throw new Error(
        `Invalid CCTP V2 capability declaration for ${entry.code}.`,
      );
    }
    if (
      typeof entry.rpcEnvKey !== "string" ||
      !/^[A-Z0-9_]+_RPC_URL$/.test(entry.rpcEnvKey) ||
      typeof entry.browserRpcEnvKey !== "string" ||
      !/^NEXT_PUBLIC_[A-Z0-9_]+_RPC_URL$/.test(entry.browserRpcEnvKey)
    ) {
      throw new Error(`Invalid RPC environment key for ${entry.code}.`);
    }
    if (
      typeof entry.defaultRpcUrl !== "string" ||
      !entry.defaultRpcUrl.startsWith("https://") ||
      typeof entry.explorerBaseUrl !== "string" ||
      !entry.explorerBaseUrl.startsWith("https://")
    ) {
      throw new Error(`Invalid public URL for ${entry.code}.`);
    }
    if (entry.source !== true || entry.destination !== true) {
      throw new Error(`Bridge network must be bidirectional: ${entry.code}.`);
    }

    codes.add(entry.code);
    chainIds.add(entry.chainId);
    domains.add(entry.cctpDomain);
  }

  if (!codes.has("ARC-TESTNET")) {
    throw new Error("Arc Testnet must be the bridge hub.");
  }

  return true;
}

validateBridgeRegistry(definitions);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const BRIDGE_TESTNETS = deepFreeze(definitions.map((entry) => ({ ...entry })));
const BRIDGE_TESTNET_BY_CODE = deepFreeze(
  Object.fromEntries(BRIDGE_TESTNETS.map((entry) => [entry.code, entry])),
);

function getBridgeTestnet(code) {
  const entry = BRIDGE_TESTNET_BY_CODE[code];
  if (!entry) throw new Error(`Unsupported bridge testnet: ${String(code)}.`);
  return entry;
}

function assertBridgeRoute(sourceCode, destinationCode) {
  const source = getBridgeTestnet(sourceCode);
  const destination = getBridgeTestnet(destinationCode);
  if (source.code === destination.code) {
    throw new Error(
      "Bridge source and destination must be different testnets.",
    );
  }
  if (source.code !== "ARC-TESTNET" && destination.code !== "ARC-TESTNET") {
    throw new Error(
      "Only Arc Testnet hub-and-spoke bridge routes are supported.",
    );
  }
  return { source, destination };
}

function assertRegistryMatch(code, candidate) {
  const expected = getBridgeTestnet(code);
  const exactFields = [
    "chainId",
    "cctpDomain",
    "usdcAddress",
    "mintEvidenceEmitter",
    "mintEvidenceDecimals",
    "tokenMessengerV2",
    "messageTransmitterV2",
    "cctpVersion",
    "usdcDecimals",
    "standardTransferSource",
    "fastTransferSource",
    "finalityThreshold",
    "nativeGasRequired",
    "environment",
  ];
  for (const field of exactFields) {
    const actual = candidate?.[field];
    const required = expected[field];
    const matches =
      typeof required === "string"
        ? typeof actual === "string" &&
          normalizedAddress(actual) === normalizedAddress(required)
        : actual === required;
    if (!matches) {
      throw new Error(`Bridge registry mismatch for ${code}: ${field}.`);
    }
  }
  return expected;
}

module.exports = {
  BRIDGE_TESTNETS,
  BRIDGE_TESTNET_BY_CODE,
  MAINNET_CHAIN_IDS,
  MESSAGE_TRANSMITTER_V2,
  CCTP_V2_TESTNET_IRIS_BASE_URL,
  TOKEN_MESSENGER_V2,
  assertBridgeRoute,
  assertRegistryMatch,
  getBridgeTestnet,
  validateBridgeRegistry,
};
