import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const REQUIRED_RPC_URL = "https://rpc.testnet.arc.io";
const ROOT = process.cwd();
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "broadcast",
  "build",
  "cache_forge",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const FORBIDDEN_FALLBACK_IDENTIFIERS = [
  ["ARC_TESTNET_RPC_", "URLS"].join(""),
  ["NEXT_PUBLIC_ARC_TESTNET_RPC_", "URLS"].join(""),
  ["ARC_TESTNET_RPC_", "FALLBACK"].join(""),
];
const URL_PATTERN = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+/g;

async function collectFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

const violations = [];

for (const path of await collectFiles(ROOT)) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    continue;
  }

  if (content.includes("\0")) {
    continue;
  }

  const file = relative(ROOT, path).replaceAll("\\", "/");

  for (const identifier of FORBIDDEN_FALLBACK_IDENTIFIERS) {
    if (content.includes(identifier)) {
      violations.push(
        `${file}: forbidden Arc RPC fallback identifier ${identifier}`,
      );
    }
  }

  for (const match of content.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(/[),.;]+$/, "");
    let hostname;
    try {
      hostname = new URL(candidate).hostname.toLowerCase();
    } catch {
      continue;
    }

    if (
      hostname.includes("arc") &&
      hostname.includes("rpc") &&
      candidate !== REQUIRED_RPC_URL
    ) {
      violations.push(
        `${file}: Arc Testnet RPC URL must be ${REQUIRED_RPC_URL}, found ${candidate}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Arc Testnet RPC audit passed: ${REQUIRED_RPC_URL} is the only endpoint.`,
  );
}
