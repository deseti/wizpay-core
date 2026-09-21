"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BRIDGE_TESTNETS,
  BRIDGE_CHAINS,
  BRIDGE_CHAIN_BY_CODE,
  CCTP_PRODUCTION,
  MAINNET_CHAIN_IDS,
  assertBridgeRoute,
  assertRegistryMatch,
  getBridgeChain,
  getBridgeFinalityThreshold,
  getBridgeTransferMode,
  getBridgeTestnet,
  listBridgeChains,
  validateBridgeChainEntry,
  validateBridgeRegistry,
} = require(".");

test("exposes no bridge testnets (mainnet-only registry)", () => {
  assert.deepEqual([...BRIDGE_TESTNETS], []);
  assert.equal(Object.isFrozen(BRIDGE_TESTNETS), true);
});

test("fails closed for any testnet bridge lookup", () => {
  for (const code of [
    "ETH-SEPOLIA",
    "BASE-SEPOLIA",
    "ARB-SEPOLIA",
    "OP-SEPOLIA",
    "ARC-TESTNET",
  ]) {
    assert.throws(() => getBridgeTestnet(code), /unavailable on Arc Mainnet/);
    assert.throws(
      () => getBridgeChain(code),
      (error) => error.code === "BRIDGE_CHAIN_UNKNOWN",
    );
  }
});

test("registers Arc Mainnet as a first-class CCTP route (domain 26)", () => {
  const arc = getBridgeChain("ARC-MAINNET");
  assert.equal(arc.chainId, 5042);
  assert.equal(arc.domain, 26);
  assert.equal(
    arc.usdcAddress,
    "0x3600000000000000000000000000000000000000",
  );
  assert.equal(
    arc.tokenMessengerV2,
    "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  );
  assert.equal(
    arc.messageTransmitterV2,
    "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  );
  assert.equal(arc.usdcDecimals, 6);
});

test("uses official CCTP V2 production constants", () => {
  assert.equal(CCTP_PRODUCTION.version, "CCTP_V2");
  assert.equal(CCTP_PRODUCTION.standardFinalityThreshold, 2000);
  assert.equal(CCTP_PRODUCTION.fastFinalityThreshold, 1000);
  assert.equal(
    CCTP_PRODUCTION.irisApiBaseUrl,
    "https://iris-api.circle.com",
  );
  assert.equal(CCTP_PRODUCTION.maxBurnAmountUnits, "10000000000000");
});

test("auto-selects Fast only where Circle marks the source Fast-available", () => {
  assert.equal(getBridgeTransferMode("BASE-MAINNET"), "fast");
  assert.equal(getBridgeFinalityThreshold("BASE-MAINNET"), 1000);
  assert.equal(getBridgeTransferMode("ETH-MAINNET"), "fast");
  assert.equal(getBridgeTransferMode("ARC-MAINNET"), "standard");
  assert.equal(getBridgeFinalityThreshold("ARC-MAINNET"), 2000);
  assert.equal(getBridgeTransferMode("POLYGON-MAINNET"), "standard");
  assert.equal(getBridgeTransferMode("AVAX-MAINNET"), "standard");
});

test("covers every registered mainnet chain ID", () => {
  const chainIds = new Set(BRIDGE_CHAINS.map((chain) => chain.chainId));
  assert.deepEqual([...chainIds].sort((a, b) => a - b), [
    ...MAINNET_CHAIN_IDS,
  ].sort((a, b) => a - b));
  assert.ok(chainIds.has(5042));
  assert.equal(BRIDGE_CHAINS.length, 7);
  assert.equal(listBridgeChains().length, 7);
  assert.equal(Object.isFrozen(BRIDGE_CHAINS), true);
});

test("validates Arc-centric production routes and rejects the rest", () => {
  const route = assertBridgeRoute("ARC-MAINNET", "BASE-MAINNET");
  assert.equal(route.source.domain, 26);
  assert.equal(route.destination.domain, 6);
  const inbound = assertBridgeRoute("ETH-MAINNET", "ARC-MAINNET");
  assert.equal(inbound.destination.chainId, 5042);
  assert.throws(
    () => assertBridgeRoute("ARC-MAINNET", "ARC-MAINNET"),
    (error) => error.code === "BRIDGE_ROUTE_SAME_CHAIN",
  );
  assert.throws(
    () => assertBridgeRoute("ETH-MAINNET", "BASE-MAINNET"),
    (error) => error.code === "BRIDGE_ROUTE_NOT_ARC",
  );
  assert.throws(
    () => assertBridgeRoute("ARC-MAINNET", "BASE-SEPOLIA"),
    (error) => error.code === "BRIDGE_CHAIN_UNKNOWN",
  );
});

test("matches registry entries exactly and rejects mismatches", () => {
  assert.equal(
    assertRegistryMatch("ARC-MAINNET", { ...BRIDGE_CHAIN_BY_CODE["ARC-MAINNET"] }),
    true,
  );
  assert.throws(
    () =>
      assertRegistryMatch("ARC-MAINNET", {
        ...BRIDGE_CHAIN_BY_CODE["ARC-MAINNET"],
        domain: 0,
      }),
    (error) => error.code === "BRIDGE_REGISTRY_MISMATCH",
  );
});

test("validates the production registry shape", () => {
  assert.equal(validateBridgeRegistry([...BRIDGE_CHAINS]), true);
  assert.throws(
    () => validateBridgeRegistry([]),
    (error) => error.code === "BRIDGE_REGISTRY_EMPTY",
  );
  assert.throws(
    () =>
      validateBridgeRegistry(
        BRIDGE_CHAINS.filter((chain) => chain.code !== "ARC-MAINNET"),
      ),
    (error) => error.code === "BRIDGE_REGISTRY_MISSING_ARC",
  );
  assert.throws(
    () => validateBridgeChainEntry({ code: "ARC-TESTNET" }),
    (error) => error.code === "BRIDGE_TESTNET_FORBIDDEN",
  );
});
