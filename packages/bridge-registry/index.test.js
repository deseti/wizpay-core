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

test("contains only the six approved CCTP V2 testnets", () => {
  assert.deepEqual(
    BRIDGE_TESTNETS.map(({ code }) => code),
    [
      "ARC-TESTNET",
      "ETH-SEPOLIA",
      "BASE-SEPOLIA",
      "ARB-SEPOLIA",
      "OP-SEPOLIA",
      "MONAD-TESTNET",
    ],
  );
  assert.equal(Object.isFrozen(BRIDGE_TESTNETS), true);
  assert.equal(Object.isFrozen(BRIDGE_TESTNETS[0]), true);
});

test("accepts only Arc hub-and-spoke routes", () => {
  assert.equal(
    assertBridgeRoute("ARC-TESTNET", "BASE-SEPOLIA").destination.code,
    "BASE-SEPOLIA",
  );
  assert.equal(
    assertBridgeRoute("MONAD-TESTNET", "ARC-TESTNET").source.code,
    "MONAD-TESTNET",
  );
  assert.throws(
    () => assertBridgeRoute("BASE-SEPOLIA", "OP-SEPOLIA"),
    /hub-and-spoke/,
  );
  assert.throws(
    () => assertBridgeRoute("ARC-TESTNET", "ARC-TESTNET"),
    /different/,
  );
});

test("rejects Robinhood, Solana, arbitrary EVM networks, and mainnets", () => {
  for (const code of [
    "ROBINHOOD-TESTNET",
    "SOLANA-DEVNET",
    "BASE",
    "ARBITRUM",
    "OP-MAINNET",
    "MONAD",
  ]) {
    assert.throws(() => getBridgeTestnet(code), /Unsupported bridge testnet/);
  }
});

test("rejects mismatched chain, domain, token, and CCTP contracts", () => {
  const arc = getBridgeTestnet("ARC-TESTNET");
  for (const mismatch of [
    { chainId: 8453 },
    { cctpDomain: 6 },
    { usdcAddress: "0x0000000000000000000000000000000000000001" },
    { tokenMessengerV2: "0x0000000000000000000000000000000000000001" },
    { messageTransmitterV2: "0x0000000000000000000000000000000000000001" },
  ]) {
    assert.throws(
      () => assertRegistryMatch(arc.code, { ...arc, ...mismatch }),
      /registry mismatch/,
    );
  }
});

test("rejects malformed and duplicate registry entries", () => {
  const arc = { ...getBridgeTestnet("ARC-TESTNET") };
  assert.throws(() => validateBridgeRegistry([]), /at least one/);
  assert.throws(
    () => validateBridgeRegistry([arc, { ...arc }]),
    /Duplicate bridge network code/,
  );
  assert.throws(
    () => validateBridgeRegistry([{ ...arc, code: "bad code" }]),
    /malformed network code/,
  );
  assert.throws(
    () => validateBridgeRegistry([{ ...arc, chainId: 1 }]),
    /Mainnet or non-testnet/,
  );
});

test("declares fail-closed CCTP V2 capabilities for every exposed chain", () => {
  for (const network of BRIDGE_TESTNETS) {
    assert.equal(network.cctpVersion, 2);
    assert.equal(network.usdcDecimals, 6);
    assert.equal(network.standardTransferSource, true);
    assert.equal(network.finalityThreshold, 2000);
    assert.equal(network.environment, "testnet");
  }
  assert.equal(getBridgeTestnet("ARC-TESTNET").fastTransferSource, false);
  assert.equal(getBridgeTestnet("MONAD-TESTNET").fastTransferSource, false);
});
