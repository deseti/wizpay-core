"use strict";

class ArcNetworkInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArcNetworkInvariantError";
    this.code = "ARC_NETWORK_INVARIANT_VIOLATION";
  }
}

class UnsupportedArcNetworkError extends Error {
  constructor(code, value) {
    super(
      code === "UNSUPPORTED_ARC_NETWORK_KEY"
        ? `Unsupported Arc network key: ${JSON.stringify(value)}.`
        : `Unsupported Arc chain ID: ${String(value)}.`,
    );
    this.name = "UnsupportedArcNetworkError";
    this.code = code;
  }
}

function assertValidDefinitionShape(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) {
    throw new ArcNetworkInvariantError(
      "Arc network definitions must contain exactly testnet and mainnet.",
    );
  }

  const keys = new Set();
  const chainIds = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new ArcNetworkInvariantError(
        "Arc network definitions must be objects.",
      );
    }
    if (keys.has(entry.key)) {
      throw new ArcNetworkInvariantError(
        `Duplicate Arc network key: ${String(entry.key)}.`,
      );
    }
    if (chainIds.has(entry.chainId)) {
      throw new ArcNetworkInvariantError(
        `Duplicate Arc chain ID: ${String(entry.chainId)}.`,
      );
    }

    if (
      (entry.environment !== "testnet" && entry.environment !== "mainnet") ||
      entry.key !== `arc-${entry.environment}` ||
      !Number.isSafeInteger(entry.chainId) ||
      entry.chainId <= 0
    ) {
      throw new ArcNetworkInvariantError(
        `Invalid Arc network definition: ${String(entry.key)}.`,
      );
    }

    keys.add(entry.key);
    chainIds.add(entry.chainId);
  }

  return true;
}

const definitions = [
  { key: "arc-testnet", chainId: 5_042_002, environment: "testnet" },
  { key: "arc-mainnet", chainId: 5_042, environment: "mainnet" },
];

assertValidDefinitionShape(definitions);

const ARC_NETWORK_DEFINITIONS = Object.freeze(
  definitions.map((definition) => Object.freeze({ ...definition })),
);
const ARC_NETWORK_BY_KEY = new Map(
  ARC_NETWORK_DEFINITIONS.map((definition) => [definition.key, definition]),
);
const ARC_NETWORK_BY_CHAIN_ID = new Map(
  ARC_NETWORK_DEFINITIONS.map((definition) => [definition.chainId, definition]),
);

function assertValidArcNetworkDefinitions(entries) {
  assertValidDefinitionShape(entries);

  for (const entry of entries) {
    const expected = ARC_NETWORK_BY_KEY.get(entry.key);
    if (
      !expected ||
      entry.chainId !== expected.chainId ||
      entry.environment !== expected.environment
    ) {
      throw new ArcNetworkInvariantError(
        `Invalid Arc network definition: ${String(entry.key)}.`,
      );
    }
  }

  return true;
}

assertValidArcNetworkDefinitions(ARC_NETWORK_DEFINITIONS);

function parseArcNetworkKey(value) {
  if (typeof value !== "string" || !ARC_NETWORK_BY_KEY.has(value)) {
    throw new UnsupportedArcNetworkError("UNSUPPORTED_ARC_NETWORK_KEY", value);
  }
  return value;
}

function getArcNetworkByKey(value) {
  return ARC_NETWORK_BY_KEY.get(parseArcNetworkKey(value));
}

function getArcNetworkByChainId(value) {
  const definition = ARC_NETWORK_BY_CHAIN_ID.get(value);
  if (!definition) {
    throw new UnsupportedArcNetworkError("UNSUPPORTED_ARC_CHAIN_ID", value);
  }
  return definition;
}

module.exports = {
  ARC_NETWORK_DEFINITIONS,
  ArcNetworkInvariantError,
  UnsupportedArcNetworkError,
  assertValidArcNetworkDefinitions,
  getArcNetworkByChainId,
  getArcNetworkByKey,
  parseArcNetworkKey,
};
