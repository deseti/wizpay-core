import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionResult, parseAbi, toFunctionSelector } from "viem";
import { runMainnetPreflight } from "./mainnet-preflight.mjs";
import {
  authorizedFixture,
  implementationAddress,
  implementationCode,
  proxyCode,
  safeSigner,
} from "./mainnet-test-fixtures.mjs";

const ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
]);
const blockHash = `0x${"44".repeat(32)}`;
function rpc({
  chainId = 5042,
  stale = false,
  advance = true,
  symbol = "USDC",
  balance = 10n ** 20n,
  codeValue = proxyCode,
  gasPrice = 1_000_000_000n,
  gasEstimate = 100_000n,
  implementation = implementationAddress,
  snapshotHash = blockHash,
  safeOwners = [safeSigner],
  safeMagic = "0x1626ba7e",
} = {}) {
  let block = 100n;
  return {
    async request(method, params = []) {
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        if (params[0] === "latest" && advance) block += 1n;
        const number = params[0] === "latest" ? block : BigInt(params[0]);
        return {
          number: `0x${number.toString(16)}`,
          timestamp: `0x${BigInt(Math.floor(new Date("2026-09-15T00:00:00.000Z").getTime() / 1000) - (stale ? 1000 : 0)).toString(16)}`,
          hash: snapshotHash,
          baseFeePerGas: "0x1",
        };
      }
      if (method === "eth_getCode")
        return String(params[0]).toLowerCase() === implementation.toLowerCase()
          ? implementationCode
          : codeValue;
      if (method === "eth_getStorageAt")
        return `0x${implementation.slice(2).padStart(64, "0")}`;
      if (method === "eth_gasPrice") return `0x${gasPrice.toString(16)}`;
      if (method === "eth_estimateGas") return `0x${gasEstimate.toString(16)}`;
      if (method === "eth_getBalance") return `0x${balance.toString(16)}`;
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_call" && params[0].to === undefined) return "0x";
      if (method === "eth_call") {
        const selector = params[0].data.slice(0, 10);
        if (selector === toFunctionSelector("getOwners()"))
          return encodeFunctionResult({
            abi: SAFE_ABI,
            functionName: "getOwners",
            result: safeOwners,
          });
        if (selector === toFunctionSelector("isValidSignature(bytes32,bytes)"))
          return encodeFunctionResult({
            abi: SAFE_ABI,
            functionName: "isValidSignature",
            result: safeMagic,
          });
        const entries = {
          "0x06fdde03": ["name", "USD Coin"],
          "0x95d89b41": ["symbol", symbol],
          "0x313ce567": ["decimals", 6],
          "0x18160ddd": ["totalSupply", 1000000n],
          "0x70a08231": ["balanceOf", 0n],
          "0xdd62ed3e": ["allowance", 0n],
        };
        const [functionName, result] = entries[selector];
        return encodeFunctionResult({ abi: ABI, functionName, result });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
function request(fixture) {
  return {
    manifest: fixture.manifest,
    plan: fixture.plan,
    rpcUrls: fixture.manifest.resources.rpcEndpoints.map((entry) => entry.url),
    expectedChainId: 5042,
    deployer: fixture.plan.deployer,
    owner: fixture.plan.owner,
    feeRecipient: fixture.plan.feeRecipient,
    feeBps: fixture.plan.feeBps,
  };
}
function deps(fixture, clients) {
  return {
    clients,
    resourceValidation: fixture.resourceValidation,
    authorizationValidation: fixture.authorizationValidation,
    planInputs: fixture.planInputs,
    blockSampling: {
      attempts: 2,
      sampleDelayMs: 0,
      now: "2026-09-15T00:00:00.000Z",
    },
    now: "2026-09-15T00:00:00.000Z",
  };
}

test("passes a coherent official, evidence-authorized, two-RPC read-only preflight", async () => {
  const fixture = await authorizedFixture();
  const output = await runMainnetPreflight(
    request(fixture),
    deps(fixture, [rpc(), rpc()]),
  );
  assert.equal(output.ok, true);
  assert.equal(output.rpcCount, 2);
  assert.equal(output.snapshotBlockHash, blockHash);
});

test("production preflight verifies Safe ownership and EIP-1271 on both RPCs", async () => {
  const fixture = await authorizedFixture({ productionAuthorization: true });
  const output = await runMainnetPreflight(
    request(fixture),
    deps(fixture, [rpc(), rpc()]),
  );
  assert.equal(output.ok, true);
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc(), rpc({ safeOwners: [fixture.plan.deployer] })]),
    ),
    /EIP-1271/,
  );
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc(), rpc({ safeMagic: "0xffffffff" })]),
    ),
    /EIP-1271/,
  );
});

test("candidate resources and unauthorized plans never authorize final preflight", async () => {
  const fixture = await authorizedFixture();
  const candidate = structuredClone(fixture.manifest);
  candidate.resources.canonicalUsdc = {
    state: "candidate",
    ...Object.fromEntries(
      Object.entries(candidate.resources.canonicalUsdc).filter(
        ([key]) => !["state", "authoritativeSource"].includes(key),
      ),
    ),
    evidence: "read-only fixture",
  };
  await assert.rejects(
    runMainnetPreflight(
      { ...request(fixture), manifest: candidate },
      deps(fixture, [rpc(), rpc()]),
    ),
    /must be official/,
  );
  await assert.rejects(
    runMainnetPreflight(
      {
        ...request(fixture),
        plan: { ...fixture.plan, authorization: { state: "unavailable" } },
      },
      deps(fixture, [rpc(), rpc()]),
    ),
    /fresh readable inputs/,
  );
});

test("rejects duplicate or non-manifest RPC URLs and chain/snapshot disagreement", async () => {
  const fixture = await authorizedFixture();
  await assert.rejects(
    runMainnetPreflight(
      {
        ...request(fixture),
        rpcUrls: [
          fixture.manifest.resources.rpcEndpoints[0].url,
          fixture.manifest.resources.rpcEndpoints[0].url,
        ],
      },
      deps(fixture, [rpc(), rpc()]),
    ),
    /do not exactly match/,
  );
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc(), rpc({ chainId: 9999 })]),
    ),
    /disagreement/,
  );
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [
        rpc({ snapshotHash: blockHash }),
        rpc({ snapshotHash: `0x${"55".repeat(32)}` }),
      ]),
    ),
    /snapshot block hash/,
  );
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc({ stale: true }), rpc({ stale: true })]),
    ),
    /stale/,
  );
});

test("rejects proxy changes, gas disagreement, unreasonable fees, and metadata mismatch", async () => {
  const fixture = await authorizedFixture();
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc(), rpc({ implementation: fixture.plan.owner })]),
    ),
    /proxy implementation/,
  );
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc(), rpc({ gasEstimate: 500_000n })]),
    ),
    /gas estimate/,
  );
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc({ gasPrice: 0n }), rpc({ gasPrice: 0n })]),
    ),
    /zero or unreasonable/,
  );
  await assert.rejects(
    runMainnetPreflight(
      request(fixture),
      deps(fixture, [rpc(), rpc({ symbol: "FAKE" })]),
    ),
    /USDC symbol|metadata mismatch/,
  );
});

test("rejects caller-mutated plan fields and fresh source/artifact mutations", async () => {
  const fixture = await authorizedFixture();
  await assert.rejects(
    runMainnetPreflight(
      {
        ...request(fixture),
        plan: {
          ...fixture.plan,
          authorization: { ...fixture.plan.authorization, reason: "tBd" },
        },
      },
      deps(fixture, [rpc(), rpc()]),
    ),
    /fresh readable inputs/,
  );
  await assert.rejects(
    runMainnetPreflight(request(fixture), {
      ...deps(fixture, [rpc(), rpc()]),
      planInputs: { ...fixture.planInputs, sourceCommit: "f".repeat(40) },
    }),
    /audited commit/,
  );
});
