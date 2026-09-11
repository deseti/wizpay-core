import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  toHex,
} from "viem";

export const MAINNET_CHAIN_ID = 5042;
export const MAX_FEE_BPS = 100;
export const SAFE_AUTHORIZATION = "PROJECT_OWNER_APPROVED_MAINNET_SAFE";
export const FEE_AUTHORIZATION = "PROJECT_OWNER_APPROVED_FEE_CONFIGURATION";
const TESTNET = new Set(
  [
    "0x32F251fc36A1174901124589EAC2d4E391816F69",
    "0xE89f7c3781Dd24baE53d6ef9Af8a6a174731b4c8",
    "0x87ACE45582f45cC81AC1E627E875AE84cbd75946",
    "0xCbaf97B317A9cAAAE27c3d8deD48d845C4064C32",
    "0x3600000000000000000000000000000000000000",
    "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
    "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed",
    "0xAA557eb00063ad487BFe0304Bd04B4d45114b721",
    "0x73742278c31a76dBb0D2587d03ef92E6E2141023",
  ].map((value) => value.toLowerCase()),
);
const INPUT_KEYS = [
  "schemaVersion",
  "network",
  "chainId",
  "contract",
  "canonicalUsdc",
  "safeOwner",
  "safeOwnerAuthorization",
  "feeRecipient",
  "feeBps",
  "feeConfigurationAuthorization",
  "deployer",
  "sourceCommit",
  "compiler",
];

function fail(message) {
  throw new Error(message);
}
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    fail(`${label} has unknown or missing fields.`);
}
function address(value, label) {
  if (typeof value !== "string" || !isAddress(value))
    fail(`${label} must be an explicit non-placeholder EVM address.`);
  const normalized = getAddress(value);
  if (
    normalized === "0x0000000000000000000000000000000000000000" ||
    /^0x([0-9a-f])\1{39}$/i.test(normalized)
  )
    fail(`${label} must not be zero or a placeholder.`);
  if (TESTNET.has(normalized.toLowerCase()))
    fail(`${label} is a known Arc Testnet resource.`);
  return normalized;
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function validateDeploymentInput(raw) {
  exactKeys(raw, INPUT_KEYS, "Deployment input");
  if (
    raw.schemaVersion !== 1 ||
    raw.network !== "arc-mainnet" ||
    raw.chainId !== MAINNET_CHAIN_ID ||
    raw.contract !== "WizPayMainnetV2"
  )
    fail(
      "Deployment identity must be WizPayMainnetV2 on arc-mainnet chain 5042.",
    );
  if (raw.safeOwnerAuthorization !== SAFE_AUTHORIZATION)
    fail("Safe owner authorization is missing.");
  if (raw.feeConfigurationAuthorization !== FEE_AUTHORIZATION)
    fail("Fee configuration authorization is missing.");
  const canonicalUsdc = address(raw.canonicalUsdc, "canonicalUsdc");
  const safeOwner = address(raw.safeOwner, "safeOwner");
  const feeRecipient = address(raw.feeRecipient, "feeRecipient");
  const deployer = address(raw.deployer, "deployer");
  if (safeOwner === deployer)
    fail("safeOwner must not equal the deployment EOA.");
  if ([safeOwner, feeRecipient, deployer].includes(canonicalUsdc))
    fail(
      "canonicalUsdc must be distinct from owner, fee recipient, and deployer.",
    );
  if (
    !Number.isInteger(raw.feeBps) ||
    raw.feeBps < 0 ||
    raw.feeBps > MAX_FEE_BPS
  )
    fail(`feeBps must be an approved integer from 0 through ${MAX_FEE_BPS}.`);
  if (
    typeof raw.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(raw.sourceCommit)
  )
    fail("sourceCommit must be a full lowercase Git commit hash.");
  exactKeys(
    raw.compiler,
    ["version", "optimizer", "optimizerRuns", "viaIR"],
    "compiler",
  );
  if (
    raw.compiler.version !== "0.8.24" ||
    raw.compiler.optimizer !== true ||
    raw.compiler.optimizerRuns !== 200 ||
    raw.compiler.viaIR !== true
  )
    fail("compiler must match the audited Foundry configuration.");
  return Object.freeze({
    ...raw,
    canonicalUsdc,
    safeOwner,
    feeRecipient,
    deployer,
    compiler: Object.freeze({ ...raw.compiler }),
  });
}

export function buildDeploymentPlan(rawInput, artifact) {
  const input = validateDeploymentInput(rawInput);
  if (
    !artifact ||
    !Array.isArray(artifact.abi) ||
    typeof artifact.bytecode?.object !== "string"
  )
    fail("A complete Foundry artifact is required.");
  const bytecode = artifact.bytecode.object.startsWith("0x")
    ? artifact.bytecode.object
    : `0x${artifact.bytecode.object}`;
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode === "0x")
    fail("Creation bytecode is unavailable.");
  const args = [
    input.canonicalUsdc,
    input.safeOwner,
    input.feeRecipient,
    input.feeBps,
  ];
  const core = {
    schemaVersion: 1,
    network: input.network,
    chainId: input.chainId,
    contract: input.contract,
    sourceCommit: input.sourceCommit,
    compiler: input.compiler,
    deployer: input.deployer,
    constructorArguments: {
      canonicalUsdc: args[0],
      initialOwner: args[1],
      feeRecipient: args[2],
      feeBps: args[3],
    },
    authorizations: {
      safeOwner: input.safeOwnerAuthorization,
      feeConfiguration: input.feeConfigurationAuthorization,
    },
    constructorDigest: keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, address, address, uint256"),
        args,
      ),
    ),
    creationBytecodeHash: keccak256(bytecode),
    initCodeHash: keccak256(
      encodeDeployData({ abi: artifact.abi, bytecode, args }),
    ),
  };
  return Object.freeze({
    ...core,
    planDigest: keccak256(toHex(stableJson(core))),
  });
}

export function validateMainnetManifest(manifest) {
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "network",
      "chainId",
      "status",
      "contract",
      "compiler",
      "deploymentInput",
      "deploymentResult",
    ],
    "Mainnet manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.network !== "arc-mainnet" ||
    manifest.chainId !== MAINNET_CHAIN_ID ||
    manifest.contract !== "WizPayMainnetV2"
  )
    fail("Mainnet manifest identity is invalid.");
  exactKeys(
    manifest.compiler,
    ["version", "optimizer", "optimizerRuns", "viaIR"],
    "manifest compiler",
  );
  exactKeys(
    manifest.deploymentInput,
    [
      "canonicalUsdc",
      "initialOwner",
      "feeRecipient",
      "feeBps",
      "deployer",
      "sourceCommit",
      "constructorArguments",
      "constructorDigest",
      "planDigest",
    ],
    "manifest deploymentInput",
  );
  exactKeys(
    manifest.deploymentResult,
    [
      "transactionHash",
      "blockNumber",
      "deployedAddress",
      "runtimeBytecodeHash",
      "verificationStatus",
    ],
    "manifest deploymentResult",
  );
  if (manifest.status === "unavailable") {
    if (Object.values(manifest.deploymentInput).some((value) => value !== null))
      fail("Unavailable manifest deployment inputs must all be null.");
    for (const [key, value] of Object.entries(manifest.deploymentResult)) {
      if (
        key === "verificationStatus" ? value !== "unavailable" : value !== null
      )
        fail(`Unavailable manifest deploymentResult.${key} is invalid.`);
    }
    return true;
  }
  if (manifest.status !== "deployed")
    fail("Mainnet manifest status must be unavailable or deployed.");
  validateDeploymentInput({
    schemaVersion: 1,
    network: manifest.network,
    chainId: manifest.chainId,
    contract: manifest.contract,
    canonicalUsdc: manifest.deploymentInput.canonicalUsdc,
    safeOwner: manifest.deploymentInput.initialOwner,
    safeOwnerAuthorization: SAFE_AUTHORIZATION,
    feeRecipient: manifest.deploymentInput.feeRecipient,
    feeBps: manifest.deploymentInput.feeBps,
    feeConfigurationAuthorization: FEE_AUTHORIZATION,
    deployer: manifest.deploymentInput.deployer,
    sourceCommit: manifest.deploymentInput.sourceCommit,
    compiler: manifest.compiler,
  });
  if (
    !Array.isArray(manifest.deploymentInput.constructorArguments) ||
    manifest.deploymentInput.constructorArguments.length !== 4
  )
    fail("Deployed manifest constructor arguments are incomplete.");
  for (const key of ["constructorDigest", "planDigest"])
    if (!/^0x[0-9a-f]{64}$/i.test(manifest.deploymentInput[key] ?? ""))
      fail(`Deployed manifest ${key} is incomplete.`);
  if (
    !/^0x[0-9a-f]{64}$/i.test(
      manifest.deploymentResult.transactionHash ?? "",
    ) ||
    !Number.isInteger(manifest.deploymentResult.blockNumber) ||
    manifest.deploymentResult.blockNumber <= 0
  )
    fail("Deployment receipt evidence is incomplete.");
  address(manifest.deploymentResult.deployedAddress, "deployedAddress");
  if (
    !/^0x[0-9a-f]{64}$/i.test(
      manifest.deploymentResult.runtimeBytecodeHash ?? "",
    )
  )
    fail("Runtime bytecode hash is incomplete.");
  if (
    !["verified", "failed", "pending"].includes(
      manifest.deploymentResult.verificationStatus,
    )
  )
    fail("Verification status is invalid.");
  return true;
}

async function cli() {
  const [command, inputPath, artifactPath, outputPath] = process.argv.slice(2);
  if (command === "validate-manifest" && inputPath && !artifactPath) {
    validateMainnetManifest(JSON.parse(await readFile(inputPath, "utf8")));
    process.stdout.write("Mainnet manifest is valid.\n");
    return;
  }
  if (command === "validate-input" && inputPath && !artifactPath) {
    validateDeploymentInput(JSON.parse(await readFile(inputPath, "utf8")));
    process.stdout.write("Mainnet deployment input is valid.\n");
    return;
  }
  if (command === "plan" && inputPath && artifactPath && outputPath) {
    const plan = buildDeploymentPlan(
      JSON.parse(await readFile(inputPath, "utf8")),
      JSON.parse(await readFile(artifactPath, "utf8")),
    );
    await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
      flag: "wx",
    });
    process.stdout.write(`${plan.planDigest}\n`);
    return;
  }
  fail(
    "Usage: validate-input <input.json> | validate-manifest <manifest.json> | plan <input.json> <artifact.json> <new-output.json>",
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  cli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
