"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BRIDGE_TESTNETS,
  assertBridgeRoute,
  assertRegistryMatch,
  getBridgeTestnet,
  validateBridgeRegistry,
} = require(".");

test("exposes no bridge routes on Arc Mainnet", () => {
  assert.deepEqual([...BRIDGE_TESTNETS], []);
  assert.equal(Object.isFrozen(BRIDGE_TESTNETS), true);
  assert.equal(validateBridgeRegistry([]), true);
});

test("fails closed for any bridge lookup on Mainnet", () => {
  for (const code of [
    "ETH-SEPOLIA",
    "BASE-SEPOLIA",
    "ARB-SEPOLIA",
    "OP-SEPOLIA",
    "MONAD-TESTNET",
  ]) {
    assert.throws(() => getBridgeTestnet(code), /unavailable on Arc Mainnet/);
  }
  assert.throws(
    () => assertBridgeRoute("ARC-MAINNET", "BASE-SEPOLIA"),
    /unavailable on Arc Mainnet/,
  );
  assert.throws(
    () => assertRegistryMatch("ARC-MAINNET", {}),
    /unavailable on Arc Mainnet/,
  );
});

test("rejects any non-empty registry on Mainnet", () => {
  assert.throws(() => validateBridgeRegistry([{ code: "ARC-MAINNET" }]), /unavailable/);
});
