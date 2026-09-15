import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { format } from "prettier";
import { compilerConfiguration, compilerDigest } from "./mainnet-deployment-plan.mjs";
import { canonicalDigest } from "./mainnet-resource-state.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const contractsRoot = fileURLToPath(new URL("..", import.meta.url));
const outputs = [
  [new URL("../abi/WizPayMainnetV2.json", import.meta.url), "json"],
  [new URL("../../../apps/backend/src/contracts/generated/wizpay-mainnet-v2.abi.ts", import.meta.url), "ts"],
  [new URL("../../../apps/frontend/constants/generated/wizpay-mainnet-v2.abi.ts", import.meta.url), "ts"],
];

export async function buildFreshMainnetArtifact(options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "wizpay-mainnet-abi-"));
  const outputDirectory = join(temporaryRoot, "out");
  const cacheDirectory = join(temporaryRoot, "cache");
  const runner = options.runner ?? execFileAsync;
  try {
    await runner("forge", ["build", "--force", "--out", outputDirectory, "--cache-path", cacheDirectory, "src/WizPayMainnetV2.sol"], { cwd: options.contractsRoot ?? contractsRoot });
    const artifactPath = join(outputDirectory, "WizPayMainnetV2.sol", "WizPayMainnetV2.json");
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const sourceCommit = String(options.sourceCommit ?? (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot ?? repositoryRoot })).stdout).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Fresh ABI build has invalid source commit provenance.");
    return { artifact, sourceCommit, artifactPath, temporaryRoot };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function expectedOutputs(options = {}) {
  const fresh = options.fresh ?? await buildFreshMainnetArtifact(options);
  try {
    const artifact = fresh.artifact;
    if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) throw new Error("Freshly compiled WizPayMainnetV2 ABI is unavailable.");
    const compiler = compilerConfiguration(artifact);
    const provenance = { contractName: "WizPayMainnetV2", sourceName: "src/WizPayMainnetV2.sol", sourceCommit: fresh.sourceCommit, sourceSetDigest: canonicalDigest(Object.fromEntries(Object.entries(artifact.metadata.sources).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, value.keccak256]))), compiler, compilerDigest: compilerDigest(compiler) };
    const json = `${JSON.stringify({ ...provenance, abi: artifact.abi }, null, 2)}\n`;
    const ts = await format(`// Generated from a clean temporary Foundry build. Do not edit manually.\n// Source commit: ${fresh.sourceCommit}; compiler digest: ${provenance.compilerDigest}.\n// Mainnet ABI only; legacy and Testnet ABIs remain separate.\nexport const WIZPAY_MAINNET_V2_ABI = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`, { parser: "typescript", singleQuote: true });
    return outputs.map(([url, type]) => [url, type === "json" ? json : ts]);
  } finally {
    if (!options.fresh && fresh.temporaryRoot) await rm(fresh.temporaryRoot, { recursive: true, force: true });
  }
}

export async function sync({ check = false, ...options } = {}) {
  for (const [url, expected] of await expectedOutputs(options)) {
    if (check) {
      const actual = await readFile(url, "utf8").catch(() => "");
      if (actual !== expected) throw new Error(`ABI drift or provenance mismatch detected: ${url.pathname}`);
    } else await writeFile(url, expected);
  }
}
async function cli() { const check = process.argv.includes("--check"); await sync({ check }); process.stdout.write(`WizPayMainnetV2 ABI ${check ? "matches" : "was synchronized from"} a clean temporary build.\n`); }
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cli().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
