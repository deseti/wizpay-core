import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { buildFreshMainnetArtifact, expectedOutputs, sync } from "./sync-mainnet-abi.mjs";

test("application Mainnet ABI copies exactly match the compiled Foundry artifact", async () => {
  await sync({ check: true });
});

test("ABI provenance never reads the stale default out directory", async () => {
  const source = await readFile(new URL("./sync-mainnet-abi.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /contracts\/out\/WizPayMainnetV2/);
  assert.match(source, /mkdtemp/);
  assert.match(source, /forge.*build/);
});

test("wrong source provenance changes every generated ABI output", async () => {
  const fresh = await buildFreshMainnetArtifact();
  try {
    const first = await expectedOutputs({ fresh: { ...fresh, sourceCommit: "1".repeat(40) } });
    const second = await expectedOutputs({ fresh: { ...fresh, sourceCommit: "2".repeat(40) } });
    for (let index = 0; index < first.length; index += 1) assert.notEqual(first[index][1], second[index][1]);
  } finally {
    await rm(fresh.temporaryRoot, { recursive: true, force: true });
  }
});
