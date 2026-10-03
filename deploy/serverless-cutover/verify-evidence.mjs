import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const [backendPath, frontendPath] = process.argv.slice(2);
const backend = JSON.parse(await readFile(backendPath, "utf8"));
const frontend = JSON.parse(await readFile(frontendPath, "utf8"));
assert.equal(backend.success, true);
assert.equal(frontend.success, true);
let focusedTests = 0;
for (const path of [
  "phase9/cli.spec.ts",
  "phase9/cutover.spec.ts",
  "phase9/smoke.spec.ts",
  "phase9/cutover.postgres.spec.ts",
]) {
  const suite = backend.testResults.find((test) =>
    test.name.endsWith("/" + path),
  );
  assert.ok(suite, "Required Phase 9 suite absent");
  assert.ok(suite.assertionResults.length > 0);
  assert.ok(
    suite.assertionResults.every((test) => test.status === "passed"),
    "Phase 9 acceptance skipped or failed",
  );
  focusedTests += suite.assertionResults.length;
}
const frontendSuite = frontend.testResults.find((test) =>
  test.name.endsWith("/lib/backend-api-configuration.test.ts"),
);
assert.ok(frontendSuite?.assertionResults.length >= 8);
assert.ok(
  frontendSuite.assertionResults.every((test) => test.status === "passed"),
);
console.log(
  JSON.stringify({
    stage: "phase9-preparation-evidence",
    result: "PASS",
    focusedTests,
    frontendTargetTests: frontendSuite.assertionResults.length,
    isolatedDatabase: "EXECUTED",
    packagedFunction: "EXECUTED",
    liveProductionGate: "NOT_EXECUTED",
  }),
);
