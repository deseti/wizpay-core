import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceDigest,
  loadMainnetUniswapV4PoolEvidence,
  validateMainnetUniswapV4PoolEvidence,
} from "./mainnet-uniswap-v4-pool-evidence.mjs";

function cloneEvidence() {
  return structuredClone(loadMainnetUniswapV4PoolEvidence());
}

function redigest(evidence) {
  evidence.canonicalEvidenceDigest = evidenceDigest(evidence);
  return evidence;
}

test("accepts deterministic candidate-only non-executable evidence", () => {
  assert.equal(validateMainnetUniswapV4PoolEvidence(cloneEvidence()), true);
});

test("rejects a modified PoolKey even when the outer digest is recomputed", () => {
  const evidence = cloneEvidence();
  evidence.candidates[0].poolKey.fee += 1;
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(redigest(evidence)),
    /PoolIds do not match/,
  );
});

test("rejects promotion or execution enablement", () => {
  const promoted = cloneEvidence();
  promoted.status = "verified";
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(redigest(promoted)),
    /candidate-only and non-executable/,
  );

  const executable = cloneEvidence();
  executable.conclusions.executable = true;
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(redigest(executable)),
    /fail closed/,
  );
});

test("rejects an incomplete scan that claims uniqueness", () => {
  const evidence = cloneEvidence();
  evidence.eventScan.uniquenessResolved = true;
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(redigest(evidence)),
    /scan completion/,
  );
});

test("rejects altered direct-swap calldata or native USDC value", () => {
  const wrongActions = cloneEvidence();
  wrongActions.directSwapEvidence[0].actions = "0x060c0f";
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(redigest(wrongActions)),
    /locked direct-swap evidence/,
  );

  const wrongNativeValue = cloneEvidence();
  wrongNativeValue.directSwapEvidence[0].nativeValue = "100000";
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(redigest(wrongNativeValue)),
    /native or Permit2 handling/,
  );
});

test("rejects credential-bearing RPC identities and digest tampering", () => {
  const credentialed = cloneEvidence();
  credentialed.rpcEvidence[0].endpointIdentity = "user@example.invalid";
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(redigest(credentialed)),
    /credential-free hostname/,
  );

  const tampered = cloneEvidence();
  tampered.observedAt = "2026-09-18T00:00:00.000Z";
  assert.throws(
    () => validateMainnetUniswapV4PoolEvidence(tampered),
    /digest mismatch/,
  );
});
