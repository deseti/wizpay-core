import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
} from "viem";
import {
  canonicalDigest,
  exactKeys,
  fail,
  stableJson,
} from "./mainnet-resource-state.mjs";

export const AUTHORIZATION_RECORD_DIRECTORY =
  "packages/contracts/deployments/authorization-records";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const RECORD_KEYS = [
  "schemaVersion",
  "recordType",
  "fixtureOnly",
  "method",
  "releaseId",
  "createdAt",
  "expiresAt",
  "safe",
  "signer",
  "publicKey",
  "payload",
  "signature",
];
const PAYLOAD_KEYS = [
  "planDigest",
  "chainId",
  "creationBytecodeHash",
  "runtimeBytecodeHash",
  "deployer",
  "finalSafeOwner",
  "feeRecipient",
  "feeBps",
  "resourceManifestDigest",
  "releaseId",
];
const AUTHORIZATION_REFERENCE_KEYS = ["state", "recordPath", "recordDigest"];
const SAFE_AUTHORIZATION_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
]);
const EIP1271_MAGIC_VALUE = "0x1626ba7e";

function tracked(root, path) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim() === path;
}

export function loadAuthorizationEvidence(
  recordPath,
  expectedDigest,
  options = {},
) {
  if (
    typeof recordPath !== "string" ||
    recordPath.includes("\\") ||
    isAbsolute(recordPath)
  )
    fail("Authorization evidence path is invalid.");
  const root = realpathSync(options.repositoryRoot ?? REPOSITORY_ROOT);
  const allowed = realpathSync(resolve(root, AUTHORIZATION_RECORD_DIRECTORY));
  const requested = resolve(root, recordPath);
  if (!requested.startsWith(`${allowed}${sep}`))
    fail(
      `Authorization evidence must be inside ${AUTHORIZATION_RECORD_DIRECTORY}.`,
    );
  let stat;
  try {
    stat = lstatSync(requested);
  } catch {
    fail("Authorization evidence does not exist.");
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    fail("Authorization evidence must be a regular non-symlink file.");
  const real = realpathSync(requested);
  if (!real.startsWith(`${allowed}${sep}`))
    fail("Authorization evidence resolves outside the allowed root.");
  const relativePath = relative(root, real).split(sep).join("/");
  if (!(options.isGitTracked ?? tracked)(root, relativePath))
    fail("Authorization evidence must be Git-tracked.");
  let record;
  try {
    record = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    fail("Authorization evidence is malformed.");
  }
  exactKeys(record, RECORD_KEYS, "Authorization evidence");
  exactKeys(record.payload, PAYLOAD_KEYS, "Authorization evidence payload");
  const digest = canonicalDigest(record);
  if (
    expectedDigest !== undefined &&
    digest !== String(expectedDigest).toLowerCase()
  )
    fail("Authorization evidence digest mismatch.");
  return { record, digest, recordPath: relativePath };
}

function sameAddress(left, right) {
  try {
    return isAddressEqual(getAddress(left), getAddress(right));
  } catch {
    return false;
  }
}

export async function verifyAuthorizationEvidence(
  plan,
  reference,
  options = {},
) {
  if (!reference || reference.state !== "authorized")
    fail("Deployment plan is not evidence-authorized.");
  exactKeys(
    reference,
    AUTHORIZATION_REFERENCE_KEYS,
    "Authorization evidence reference",
  );
  const { record, digest, recordPath } = loadAuthorizationEvidence(
    reference.recordPath,
    reference.recordDigest ?? undefined,
    options,
  );
  if (
    record.schemaVersion !== 1 ||
    record.recordType !== "wizpay-mainnet-deployment-authorization"
  )
    fail("Authorization evidence schema is unsupported.");
  if (
    record.fixtureOnly !== false &&
    !(options.allowTestFixtures === true && record.fixtureOnly === true)
  )
    fail("Fixture authorization cannot authorize production preflight.");
  const created = Date.parse(record.createdAt);
  const expires = Date.parse(record.expiresAt);
  const now =
    options.now === undefined ? Date.now() : new Date(options.now).getTime();
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    created > now ||
    expires <= now ||
    expires <= created
  )
    fail("Authorization evidence is expired or outside its freshness bounds.");
  if (
    typeof record.releaseId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.releaseId)
  )
    fail("Authorization release ID is invalid.");
  const expected = {
    planDigest: plan.planDigest,
    chainId: String(plan.chainId),
    creationBytecodeHash: plan.creationBytecodeHash,
    runtimeBytecodeHash: plan.runtimeBytecodeHash,
    deployer: plan.deployer,
    finalSafeOwner: plan.owner,
    feeRecipient: plan.feeRecipient,
    feeBps: plan.feeBps,
    resourceManifestDigest: plan.resourceManifestDigest,
    releaseId: record.releaseId,
  };
  if (stableJson(record.payload) !== stableJson(expected))
    fail("Authorization evidence does not bind the exact deployment plan.");
  if (
    record.payload.releaseId !== record.releaseId ||
    !sameAddress(record.safe, plan.owner) ||
    !sameAddress(record.payload.finalSafeOwner, record.safe)
  )
    fail("Authorization Safe or release identity mismatch.");
  const signedPayload = Buffer.from(stableJson(record.payload));
  if (record.method === "ed25519-test-fixture-v1") {
    if (!record.fixtureOnly || options.allowTestFixtures !== true)
      fail("Test authorization method is forbidden in production.");
    if (!sameAddress(record.signer, record.safe))
      fail("Fixture authorization signer mismatch.");
    if (
      typeof record.publicKey !== "string" ||
      typeof record.signature !== "string" ||
      !verifySignature(
        null,
        signedPayload,
        createPublicKey(record.publicKey),
        Buffer.from(record.signature, "base64"),
      )
    )
      fail("Authorization signature is invalid.");
  } else if (record.method === "safe-eip1271-v1") {
    if (
      record.fixtureOnly ||
      record.publicKey !== null ||
      typeof record.signature !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(record.signature)
    )
      fail("Safe authorization record is malformed.");
    if (
      typeof options.verifySafeSignature !== "function" ||
      !(await options.verifySafeSignature({
        safe: getAddress(record.safe),
        signer: getAddress(record.signer),
        payload: signedPayload,
        payloadDigest: canonicalDigest(record.payload),
        signature: record.signature,
      }))
    )
      fail("Safe EIP-1271 authorization signature is invalid or unverifiable.");
  } else fail("Authorization verification method is unsupported.");
  return Object.freeze({
    state: "authorized",
    recordPath,
    recordDigest: digest,
    releaseId: record.releaseId,
    method: record.method,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    safe: getAddress(record.safe),
    signer: getAddress(record.signer),
  });
}

export function createSafeEip1271Verifier(clients, blockTag = "latest") {
  return async ({ safe, signer, payloadDigest, signature }) => {
    if (!Array.isArray(clients) || clients.length !== 2) return false;
    const ownerCall = encodeFunctionData({
      abi: SAFE_AUTHORIZATION_ABI,
      functionName: "getOwners",
    });
    const signatureCall = encodeFunctionData({
      abi: SAFE_AUTHORIZATION_ABI,
      functionName: "isValidSignature",
      args: [payloadDigest, signature],
    });
    try {
      const results = await Promise.all(
        clients.map(async (client) => {
          const chainId = BigInt(await client.request("eth_chainId"));
          if (chainId !== 5042n) return false;
          const code = await client.request("eth_getCode", [safe, blockTag]);
          if (typeof code !== "string" || code === "0x") return false;
          const ownersResult = await client.request("eth_call", [
            { to: safe, data: ownerCall },
            blockTag,
          ]);
          const owners = decodeFunctionResult({
            abi: SAFE_AUTHORIZATION_ABI,
            functionName: "getOwners",
            data: ownersResult,
          });
          if (!owners.some((owner) => sameAddress(owner, signer))) return false;
          const signatureResult = await client.request("eth_call", [
            { to: safe, data: signatureCall },
            blockTag,
          ]);
          return (
            decodeFunctionResult({
              abi: SAFE_AUTHORIZATION_ABI,
              functionName: "isValidSignature",
              data: signatureResult,
            }).toLowerCase() === EIP1271_MAGIC_VALUE
          );
        }),
      );
      return results.every(Boolean);
    } catch {
      return false;
    }
  };
}
