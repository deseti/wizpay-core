import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const backend = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(backend.success, true);
let focusedTests = 0;
for (const path of [
  "phase10/decommission.spec.ts",
  "phase10/dns.spec.ts",
  "phase10/inventory.spec.ts",
  "phase10/reconciliation.postgres.spec.ts",
]) {
  const suite = backend.testResults.find((test) =>
    test.name.endsWith("/" + path),
  );
  assert.ok(
    suite?.assertionResults.length > 0,
    "Phase 10 evidence suite absent",
  );
  assert.ok(
    suite.assertionResults.every((test) => test.status === "passed"),
    "Phase 10 required test skipped/failed",
  );
  focusedTests += suite.assertionResults.length;
}
console.log(
  JSON.stringify({
    stage: "phase10-preparation-evidence",
    result: "PASS",
    focusedTests,
    isolatedReadOnlyDatabaseChecks: "EXECUTED",
    liveShutdown: "NOT_EXECUTED",
    subscriptionCancellation: "NOT_EXECUTED",
  }),
);
