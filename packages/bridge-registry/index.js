"use strict";

const MAINNET_CHAIN_IDS = Object.freeze([1, 10, 143, 8453, 42161, 4663]);

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

function assertBridgeRoute() {
  return bridgeUnavailable();
}

function assertRegistryMatch() {
  return bridgeUnavailable();
}

function validateBridgeRegistry(entries) {
  if (!Array.isArray(entries) || entries.length !== 0) {
    throw new Error("Bridge is unavailable on Arc Mainnet.");
  }
  return true;
}

validateBridgeRegistry([]);

module.exports = {
  BRIDGE_TESTNETS,
  BRIDGE_TESTNET_BY_CODE,
  MAINNET_CHAIN_IDS,
  assertBridgeRoute,
  assertRegistryMatch,
  getBridgeTestnet,
  validateBridgeRegistry,
};
