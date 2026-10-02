import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  brokerRequest,
  requestOidc,
  run,
  SETTINGS,
  validationEnvironment,
  verifyCertificate,
} from "./phase2-oidc-bootstrap.mjs";

const environment = {
  GITHUB_RUN_ID: "37045203379",
  GITHUB_RUN_ATTEMPT: "1",
  ACTIONS_ID_TOKEN_REQUEST_URL:
    "https://test.actions.githubusercontent.com/token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token",
  GH_TOKEN: "do-not-forward",
};
const role = "wizpay_p2_37045203379_1",
  password = "synthetic-password-".repeat(4);
const make = (port) =>
  `postgresql://${role}.${SETTINGS.project}:${password}@${SETTINGS.host}:${port}/postgres?sslmode=verify-full`;
const body = {
  role,
  directCredentialVerified: true,
  sessionUrl: make(5432),
  transactionUrl: make(6543),
  expiresAt: new Date(Date.now() + 1800_000).toISOString(),
};
test("OIDC request uses dedicated audience and masks token before returning", async () => {
  const masks = [];
  const fetcher = async (input, options) => {
    assert.equal(
      new URL(input).searchParams.get("audience"),
      SETTINGS.audience,
    );
    assert.equal(
      options.headers.authorization,
      `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    );
    return Response.json({ value: "synthetic-oidc-jwt" });
  };
  assert.equal(
    await requestOidc(environment, fetcher, (value) => masks.push(value)),
    "synthetic-oidc-jwt",
  );
  assert.deepEqual(masks, ["synthetic-oidc-jwt"]);
});
test("bootstrap masks URLs/password before validation and emits no ordinary credential logs", async () => {
  const masks = [],
    logs = [],
    original = console.log;
  let calls = 0;
  const fetcher = async () =>
    ++calls === 1
      ? Response.json({ value: "synthetic-oidc-jwt" })
      : Response.json(body);
  console.log = (...args) => logs.push(args);
  try {
    assert.deepEqual(
      await brokerRequest("bootstrap", environment, fetcher, (value) =>
        masks.push(value),
      ),
      body,
    );
    assert(
      masks.includes(body.sessionUrl) &&
        masks.includes(body.transactionUrl) &&
        masks.includes(password),
    );
    assert.deepEqual(logs, []);
  } finally {
    console.log = original;
  }
});
test("guarded child environment binds run and endpoint modes and removes OIDC/GitHub authority", () => {
  const child = validationEnvironment(
    body,
    environment,
    "/tmp/public-root.crt",
  );
  assert.equal(child.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(child.GH_TOKEN, undefined);
  assert.equal(child.WIZPAY_EXTERNAL_TEST_ACK, "ISOLATED_NONPRODUCTION_SCHEMA");
  assert.equal(
    new URL(child.WIZPAY_EXTERNAL_TEST_DATABASE_URL).searchParams.get(
      "sslmode",
    ),
    "verify-full",
  );
  assert.equal(
    new URL(child.WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL).port,
    "6543",
  );
  for (const change of [
    { directCredentialVerified: false },
    { directCredentialVerified: undefined },
    { role: "postgres" },
    { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    { transactionUrl: make(5432) },
    { sessionUrl: make(5432).replace("verify-full", "require") },
    { sessionUrl: make(5432).replace(SETTINGS.host, "attacker.invalid") },
  ])
    assert.throws(() =>
      validationEnvironment(
        { ...body, ...change },
        environment,
        "/tmp/root.crt",
      ),
    );
});
test("CA identity/fingerprint validation rejects malformed or unrelated material", () => {
  assert.throws(() => verifyCertificate("not a certificate"));
});
test("a valid unrelated CA is rejected by its certificate fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wizpay-ca-negative-"));
  try {
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "synthetic.key"),
        "-out",
        join(directory, "synthetic.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=Unrelated validation fixture",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    const pem = await readFile(join(directory, "synthetic.crt"), "utf8");
    assert.throws(() => verifyCertificate(pem));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("cleanup uses a fresh token and never requires persisted database credentials", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push([String(url), options]);
    return requests.length === 1
      ? Response.json({ value: "fresh-cleanup-jwt" })
      : Response.json({ cleaned: true });
  };
  assert.deepEqual(
    await brokerRequest("cleanup", environment, fetcher, () => undefined),
    { cleaned: true },
  );
  assert.equal(JSON.parse(requests[1][1].body).action, "cleanup");
  assert.equal(
    requests[1][1].headers.authorization,
    "Bearer fresh-cleanup-jwt",
  );
});
test("runner refuses unverified broker credentials before invoking the live validator", async () => {
  let calls = 0;
  const execute = () => {
    throw new Error("Validator must not run");
  };
  const fetcher = async () => {
    calls++;
    assert(calls <= 2, "CA fetching must not start without direct proof");
    return calls === 1
      ? Response.json({ value: "synthetic-jwt" })
      : Response.json({ ...body, directCredentialVerified: false });
  };
  await assert.rejects(() =>
    run("bootstrap", environment, fetcher, () => undefined, execute),
  );
  assert.equal(calls, 2);
});
test("workflow stays secretless and cleanup/checkout checks run even on preflight failure", async () => {
  const source = await readFile(
    new URL("../workflows/phase2-supabase-validation.yml", import.meta.url),
    "utf8",
  );
  assert(source.includes("id-token: write"));
  assert(source.includes("contents: read"));
  assert(source.includes("branches: [feat/serverless-free-stack]"));
  assert(
    source.includes(
      "if: github.ref == 'refs/heads/feat/serverless-free-stack'",
    ),
  );
  assert(
    !/secrets\.|vars\.|GITHUB_ENV|GITHUB_OUTPUT|upload-artifact|supabase deploy|migrate reset|db push/.test(
      source,
    ),
  );
  assert(
    /- name: Revoke[^\n]*\n\s+if: always\(\)\n\s+run: node \.github\/scripts\/phase2-oidc-bootstrap\.mjs cleanup/.test(
      source,
    ),
  );
  assert(/- name: Verify unchanged checkout\n\s+if: always\(\)/.test(source));
});
