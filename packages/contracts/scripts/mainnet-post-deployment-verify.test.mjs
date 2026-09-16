import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeFunctionResult,
  getContractAddress,
  parseAbi,
  toFunctionSelector,
} from "viem";
import { verifyMainnetDeployment } from "./mainnet-post-deployment-verify.mjs";
import { authorizedFixture, safeSigner } from "./mainnet-test-fixtures.mjs";

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function canonicalUsdc() view returns (address)",
  "function feeCollector() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function paused() view returns (bool)",
]);
const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
]);
const txHash = `0x${"ab".repeat(32)}`;
const receiptHash = `0x${"66".repeat(32)}`;
const stateHash = `0x${"77".repeat(32)}`;
function runtime(plan, artifact) {
  const chars = artifact.deployedBytecode.object.slice(2).split("");
  chars.splice(
    32,
    64,
    ...plan.canonicalUsdc.slice(2).toLowerCase().padStart(64, "0"),
  );
  return `0x${chars.join("")}`;
}

function rpc(fixture, overrides = {}) {
  const plan = fixture.plan;
  const expectedAddress = getContractAddress({
    from: plan.deployer,
    nonce: 7n,
  });
  const values = {
    owner: plan.owner,
    canonicalUsdc: plan.canonicalUsdc,
    feeCollector: plan.feeRecipient,
    feeBps: BigInt(plan.feeBps),
    paused: false,
    ...overrides.values,
  };
  let canonicalReads = 0;
  return {
    async request(method, params = []) {
      if (method === "eth_chainId")
        return `0x${BigInt(overrides.chainId ?? 5042).toString(16)}`;
      if (method === "eth_getTransactionReceipt")
        return {
          status: overrides.status ?? "0x1",
          blockNumber: "0x64",
          blockHash: overrides.receiptBlockHash ?? receiptHash,
          contractAddress: overrides.contractAddress ?? expectedAddress,
          transactionHash: overrides.receiptTransactionHash ?? txHash,
          from: overrides.receiptFrom ?? plan.deployer,
          to: overrides.receiptTo === undefined ? null : overrides.receiptTo,
          transactionIndex: "0x2",
        };
      if (method === "eth_getTransactionByHash")
        return {
          from: overrides.sender ?? plan.deployer,
          to: overrides.to === undefined ? null : overrides.to,
          nonce: "0x7",
          input: overrides.input ?? plan.initCode,
          hash: overrides.transactionHash ?? txHash,
          blockHash: overrides.transactionBlockHash ?? receiptHash,
          blockNumber: "0x64",
          transactionIndex: "0x2",
        };
      if (method === "eth_getBlockByNumber") {
        if (params[0] === "latest")
          return {
            number: overrides.latestBlock ?? "0x78",
            timestamp: "0x6aa88a80",
            hash: stateHash,
          };
        if (params[0] === "0x64") {
          canonicalReads += 1;
          return {
            number: "0x64",
            timestamp: "0x6aa88980",
            hash:
              overrides.reorgHash && canonicalReads > 1
                ? overrides.reorgHash
                : (overrides.canonicalHash ?? receiptHash),
          };
        }
        return {
          number: params[0],
          timestamp: "0x6aa88a80",
          hash: overrides.stateHash ?? stateHash,
        };
      }
      if (method === "eth_getCode")
        return overrides.code ?? runtime(plan, fixture.artifact);
      if (method === "eth_call") {
        const selector = params[0].data.slice(0, 10);
        if (selector === toFunctionSelector("getOwners()"))
          return encodeFunctionResult({
            abi: SAFE_ABI,
            functionName: "getOwners",
            result: overrides.safeOwners ?? [safeSigner],
          });
        if (selector === toFunctionSelector("isValidSignature(bytes32,bytes)"))
          return encodeFunctionResult({
            abi: SAFE_ABI,
            functionName: "isValidSignature",
            result: overrides.safeMagic ?? "0x1626ba7e",
          });
        const names = Object.fromEntries(
          ["owner", "canonicalUsdc", "feeCollector", "feeBps", "paused"].map(
            (name) => [toFunctionSelector(`${name}()`), name],
          ),
        );
        const functionName = names[selector];
        return encodeFunctionResult({
          abi: ABI,
          functionName,
          result: values[functionName],
        });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
function request(fixture, extra = {}) {
  return {
    plan: fixture.plan,
    manifest: fixture.manifest,
    rpcUrls: fixture.manifest.resources.rpcEndpoints.map((entry) => entry.url),
    transactionHash: txHash,
    deployedAddress: getContractAddress({
      from: fixture.plan.deployer,
      nonce: 7n,
    }),
    requiredConfirmations: "12",
    ...extra,
  };
}
function deps(fixture, clients, extra = {}) {
  return {
    clients,
    resourceValidation: fixture.resourceValidation,
    authorizationValidation: fixture.authorizationValidation,
    planInputs: fixture.planInputs,
    now: "2026-09-15T00:00:00.000Z",
    reorgDelayMs: 0,
    ...extra,
  };
}

test("emits deterministic verified output only after complete two-RPC reconciliation", async () => {
  const fixture = await authorizedFixture();
  const first = await verifyMainnetDeployment(
    request(fixture),
    deps(fixture, [rpc(fixture), rpc(fixture)]),
  );
  const second = await verifyMainnetDeployment(
    request(fixture),
    deps(fixture, [rpc(fixture), rpc(fixture)]),
  );
  assert.deepEqual(first, second);
  assert.equal(first.status, "verified");
  assert.equal(first.transactionHash, txHash);
});

test("post-deployment verification requires production Safe authorization on both RPCs", async () => {
  const fixture = await authorizedFixture({ productionAuthorization: true });
  const output = await verifyMainnetDeployment(
    request(fixture),
    deps(fixture, [rpc(fixture), rpc(fixture)]),
  );
  assert.equal(output.status, "verified");
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [rpc(fixture), rpc(fixture, { safeMagic: "0xffffffff" })]),
    ),
    /EIP-1271/,
  );
});

test("rejects zero/negative confirmations, hash substitution, non-CREATE, sender, and receipt inconsistencies", async () => {
  const fixture = await authorizedFixture();
  for (const confirmations of ["0", "-1"])
    await assert.rejects(
      verifyMainnetDeployment(
        request(fixture, { requiredConfirmations: confirmations }),
        deps(fixture, [rpc(fixture), rpc(fixture)]),
      ),
      /positive integer/,
    );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { transactionHash: `0x${"cc".repeat(32)}` }),
        rpc(fixture, { transactionHash: `0x${"cc".repeat(32)}` }),
      ]),
    ),
    /hashes differ/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { to: fixture.plan.owner }),
        rpc(fixture, { to: fixture.plan.owner }),
      ]),
    ),
    /CREATE/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { receiptTo: fixture.plan.owner }),
        rpc(fixture, { receiptTo: fixture.plan.owner }),
      ]),
    ),
    /CREATE/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { sender: fixture.plan.owner }),
        rpc(fixture, { sender: fixture.plan.owner }),
      ]),
    ),
    /sender mismatch/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { receiptFrom: fixture.plan.owner }),
        rpc(fixture, { receiptFrom: fixture.plan.owner }),
      ]),
    ),
    /inconsistent/,
  );
});

test("rejects stale chain, reorg, wrong code, source/artifact mutation, and RPC disagreement", async () => {
  const fixture = await authorizedFixture();
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { latestBlock: "0x63" }),
        rpc(fixture, { latestBlock: "0x63" }),
      ]),
    ),
    /below the receipt/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { reorgHash: `0x${"99".repeat(32)}` }),
        rpc(fixture, { reorgHash: `0x${"99".repeat(32)}` }),
      ]),
    ),
    /reorg-stability/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [
        rpc(fixture, { code: "0x6001" }),
        rpc(fixture, { code: "0x6001" }),
      ]),
    ),
    /bytecode hash/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [rpc(fixture), rpc(fixture)], {
        planInputs: { ...fixture.planInputs, sourceCommit: "f".repeat(40) },
      }),
    ),
    /audited commit/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      request(fixture),
      deps(fixture, [rpc(fixture), rpc(fixture, { status: "0x0" })]),
    ),
    /RPC disagreement/,
  );
});

test("rejects candidate manifests and unauthorized plans", async () => {
  const fixture = await authorizedFixture();
  const candidate = structuredClone(fixture.manifest);
  candidate.resources.chainId = {
    state: "candidate",
    value: 5042,
    evidence: "read only",
  };
  await assert.rejects(
    verifyMainnetDeployment(
      { ...request(fixture), manifest: candidate },
      deps(fixture, [rpc(fixture), rpc(fixture)]),
    ),
    /must be official/,
  );
  await assert.rejects(
    verifyMainnetDeployment(
      {
        ...request(fixture),
        plan: { ...fixture.plan, authorization: { state: "unavailable" } },
      },
      deps(fixture, [rpc(fixture), rpc(fixture)]),
    ),
    /fresh readable inputs/,
  );
});
