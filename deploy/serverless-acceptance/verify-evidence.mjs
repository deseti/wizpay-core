import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Consume test-runner reports, never application payloads or driver diagnostics.
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const [backendPath, frontendPath, browserPath] = process.argv.slice(2);
assert.ok(
  backendPath && frontendPath && browserPath,
  "Three test reports required",
);
const matrix = await read(
  fileURLToPath(new URL("./phase8-acceptance.json", import.meta.url)),
);
const backend = await read(backendPath);
const frontend = await read(frontendPath);
const browser = await read(browserPath);
assert.equal(backend.success, true, "Backend suite failed");
assert.equal(frontend.success, true, "Frontend suite failed");
assert.equal(browser.stats.unexpected, 0, "Browser acceptance failed");
assert.equal(browser.stats.skipped, 0, "Browser acceptance was skipped");
assert.ok(browser.stats.expected >= 6, "Desktop/mobile coverage missing");
const results = [...backend.testResults, ...frontend.testResults];
for (const feature of matrix.features) {
  for (const path of feature.acceptance_tests) {
    if (path.endsWith("/e2e/phase8.spec.ts")) continue;
    const executed = results.find((result) => result.name.endsWith("/" + path));
    assert.ok(executed, `Acceptance suite absent: ${path}`);
    assert.ok(
      executed.assertionResults.some((test) => test.status === "passed"),
      `Acceptance suite skipped: ${path}`,
    );
    assert.equal(
      executed.assertionResults.some((test) => test.status === "failed"),
      false,
      `Acceptance failed: ${path}`,
    );
  }
}
// These integration tests must execute; a green suite with skipped databases
// cannot be mistaken for persistence, lease or migration evidence.
for (const suffix of [
  "deployment/phase8-acceptance.postgres.spec.ts",
  "deployment/vercel-bundle.postgres.spec.ts",
  "database/persistence.postgres.spec.ts",
  "execution-intent/execution-intent.postgres.spec.ts",
  "reconciliation/reconciliation.postgres.spec.ts",
  "phase7/migration-rehearsal.postgres.spec.ts",
]) {
  const executed = backend.testResults.find((result) =>
    result.name.endsWith("/" + suffix),
  );
  assert.ok(
    executed?.assertionResults.some((test) => test.status === "passed"),
    `Isolated integration missing: ${suffix}`,
  );
}
assert.ok(
  matrix.deferred_evidence.every(
    (item) =>
      item.result === "DEFERRED" && item.evidence_type === "DEFERRED_HOSTED",
  ),
);
console.log(
  JSON.stringify({
    stage: "phase8-matrix-evidence",
    result: "PASS",
    features: matrix.features.length,
    backendSuites: backend.numPassedTestSuites,
    backendTests: backend.numPassedTests,
    frontendFiles: frontend.testResults.length,
    frontendTests: frontend.numPassedTests,
    browserTests: browser.stats.expected,
    hostedEvidence: "DEFERRED",
  }),
);
