"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ARC_NETWORK_DEFINITIONS,
  ArcNetworkInvariantError,
  UnsupportedArcNetworkError,
  assertValidArcNetworkDefinitions,
  getArcNetworkByChainId,
  getArcNetworkByKey,
  parseArcNetworkKey,
} = require(".");

test("defines the exact Arc Testnet and Mainnet identities", () => {
  assert.deepEqual(ARC_NETWORK_DEFINITIONS, [
    { key: "arc-testnet", chainId: 5_042_002, environment: "testnet" },
    { key: "arc-mainnet", chainId: 5_042, environment: "mainnet" },
  ]);
  assert.notEqual(
    ARC_NETWORK_DEFINITIONS[0].chainId,
    ARC_NETWORK_DEFINITIONS[1].chainId,
  );
});

test("resolves both exact network keys", () => {
  assert.equal(getArcNetworkByKey("arc-testnet").chainId, 5_042_002);
  assert.equal(getArcNetworkByKey("arc-mainnet").chainId, 5_042);
  assert.equal(parseArcNetworkKey("arc-testnet"), "arc-testnet");
  assert.equal(parseArcNetworkKey("arc-mainnet"), "arc-mainnet");
});

test("resolves both exact chain IDs", () => {
  assert.equal(getArcNetworkByChainId(5_042_002).key, "arc-testnet");
  assert.equal(getArcNetworkByChainId(5_042).key, "arc-mainnet");
});

test("strictly rejects empty, whitespace, unknown, case-modified, and near-match keys", () => {
  for (const value of [
    "",
    "   ",
    "unknown",
    "ARC-TESTNET",
    "arc-Testnet",
    "arc-testnet ",
    "arc-main",
    undefined,
    null,
  ]) {
    assert.throws(
      () => getArcNetworkByKey(value),
      (error) =>
        error instanceof UnsupportedArcNetworkError &&
        error.code === "UNSUPPORTED_ARC_NETWORK_KEY",
    );
  }
});

test("rejects unknown and malformed chain IDs without a default", () => {
  for (const value of [0, 1, 5_043, 50_420_020, "5042", undefined, null]) {
    assert.throws(
      () => getArcNetworkByChainId(value),
      (error) =>
        error instanceof UnsupportedArcNetworkError &&
        error.code === "UNSUPPORTED_ARC_CHAIN_ID",
    );
  }
});

test("exposes frozen definitions", () => {
  assert.equal(Object.isFrozen(ARC_NETWORK_DEFINITIONS), true);
  for (const definition of ARC_NETWORK_DEFINITIONS) {
    assert.equal(Object.isFrozen(definition), true);
    assert.throws(() => {
      definition.chainId = 1;
    }, TypeError);
  }
  assert.equal(getArcNetworkByKey("arc-mainnet").chainId, 5_042);
});

test("validates key, chain ID, and environment relationships", () => {
  assert.equal(assertValidArcNetworkDefinitions(ARC_NETWORK_DEFINITIONS), true);
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 5_042_002, environment: "mainnet" },
        { key: "arc-mainnet", chainId: 5_042, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arc-mainnet with chain ID 5043", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        ARC_NETWORK_DEFINITIONS[0],
        { key: "arc-mainnet", chainId: 5_043, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arc-testnet with chain ID 5042", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 5_042, environment: "testnet" },
        ARC_NETWORK_DEFINITIONS[1],
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects swapped canonical chain IDs", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 5_042, environment: "testnet" },
        { key: "arc-mainnet", chainId: 5_042_002, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("rejects arbitrary positive chain IDs with correct keys and environments", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        { key: "arc-testnet", chainId: 7, environment: "testnet" },
        { key: "arc-mainnet", chainId: 8, environment: "mainnet" },
      ]),
    ArcNetworkInvariantError,
  );
});

test("detects duplicate keys and chain IDs", () => {
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        ARC_NETWORK_DEFINITIONS[0],
        { ...ARC_NETWORK_DEFINITIONS[0] },
      ]),
    /Duplicate Arc network key/,
  );
  assert.throws(
    () =>
      assertValidArcNetworkDefinitions([
        ARC_NETWORK_DEFINITIONS[0],
        {
          ...ARC_NETWORK_DEFINITIONS[1],
          chainId: ARC_NETWORK_DEFINITIONS[0].chainId,
        },
      ]),
    /Duplicate Arc chain ID/,
  );
});
