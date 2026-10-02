import assert from "node:assert/strict";
import { createHandler } from "./handler.ts";
import { FakeDatabase } from "./test-database.ts";
import {
  directCredentialOptions,
  verifyDirectCredentials,
} from "./direct-credentials.ts";
import {
  CI,
  randomPassword,
  runIdentity,
  scramVerifier,
  TARGET,
  verifyOidc,
} from "./security.ts";

const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...await crypto.subtle.exportKey("jwk", pair.publicKey),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const now = Math.floor(Date.now() / 1000);
const identity = { runId: "37045203379", attempt: "1" };
const claims = {
  iss: TARGET.issuer,
  aud: TARGET.audience,
  repository: TARGET.repository,
  ref: TARGET.ref,
  sub: `repo:${TARGET.repository}:ref:${TARGET.ref}`,
  workflow_ref: TARGET.workflow,
  event_name: "push",
  run_id: identity.runId,
  run_attempt: identity.attempt,
  exp: now + 300,
  iat: now,
  nbf: now,
};
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
async function token(
  overrides: Record<string, unknown> = {},
  key = pair.privateKey,
) {
  const content = [{ alg: "RS256", typ: "JWT", kid: "test-key" }, {
    ...claims,
    ...overrides,
  }].map((value) => encode(new TextEncoder().encode(JSON.stringify(value))))
    .join(".");
  return `${content}.${
    encode(
      new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          key,
          new TextEncoder().encode(content),
        ),
      ),
    )
  }`;
}
const fetchJwks: typeof fetch = (input) => {
  assert.equal(String(input), TARGET.jwks);
  return Promise.resolve(Response.json({ keys: [jwk] }));
};
Deno.test("signed GitHub workflow identity accepted and wrong claims rejected", async () => {
  assert.deepEqual(await verifyOidc(await token(), fetchJwks, now), identity);
  for (
    const extra of [
      { iss: "https://attacker.invalid" },
      { aud: "wrong" },
      { aud: [TARGET.audience, "other"] },
      { repository: "attacker/wizpay-core" },
      { ref: "refs/heads/main" },
      {
        workflow_ref: TARGET.workflow.replace(
          "phase2-supabase-validation",
          "other",
        ),
      },
      { job_workflow_ref: "attacker/reusable" },
      { sub: "repo:attacker/repo:ref:refs/heads/main" },
      { event_name: "pull_request" },
      { exp: now - 1 },
      { iat: now - 1000 },
      { exp: now + 3600 },
      { nbf: now + 120 },
      { run_id: "1; DROP ROLE postgres" },
    ]
  ) {
    await assert.rejects(() =>
      token(extra).then((jwt) => verifyOidc(jwt, fetchJwks, now))
    );
  }
});
Deno.test("optional JWK algorithm metadata does not change the enforced RS256 signature algorithm", async () => {
  const jwt = await token();
  const withoutAlgorithm: typeof fetch = () =>
    Promise.resolve(Response.json({ keys: [{ ...jwk, alg: undefined }] }));
  assert.deepEqual(await verifyOidc(jwt, withoutAlgorithm, now), identity);
  const wrongAlgorithm: typeof fetch = () =>
    Promise.resolve(Response.json({ keys: [{ ...jwk, alg: "HS256" }] }));
  await assert.rejects(() => verifyOidc(jwt, wrongAlgorithm, now));
});
Deno.test("invalid signatures, unsigned tokens and malformed JWTs rejected", async () => {
  const other = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  await assert.rejects(() =>
    token({}, other.privateKey).then((jwt) => verifyOidc(jwt, fetchJwks, now))
  );
  for (
    const jwt of [
      "",
      "not.a.token",
      "x",
      `${encode(new TextEncoder().encode('{"alg":"none"}'))}.e30.`,
      "a".repeat(16_385),
    ]
  ) await assert.rejects(() => verifyOidc(jwt, fetchJwks, now));
});
Deno.test("bounded OIDC run identity, fixed CI targets, random passwords and SCRAM verifier", async () => {
  assert.deepEqual(runIdentity("9".repeat(20), "9".repeat(6)), {
    runId: "9".repeat(20),
    attempt: "9".repeat(6),
  });
  assert.throws(() => runIdentity("9".repeat(21), "1"));
  assert.throws(() => runIdentity("postgres", "1"));
  assert.equal(CI.role, "wizpay_phase2_ci");
  assert.equal(CI.secret, "wizpay_phase2_ci_password_v1");
  assert.equal(CI.marker, "wizpay-phase2-ci:v1");
  const first = randomPassword(), second = randomPassword();
  assert.notEqual(first, second);
  assert.equal(first.length, 64);
  const verifier = await scramVerifier(first);
  assert(verifier.startsWith("SCRAM-SHA-256$16384:"));
  assert(!verifier.includes(first));
});

Deno.test("broker returns URLs only to authenticated invocation and never logs them", async () => {
  const db = new FakeDatabase();
  let connections = 0;
  const handler = createHandler(() => {
    connections++;
    return Promise.resolve(db);
  }, fetchJwks);
  const messages: unknown[][] = [];
  const original = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...args) => {
    messages.push(args);
  };
  try {
    const invalid = await handler(
      new Request("https://broker.invalid", {
        method: "POST",
        headers: {
          authorization: "Bearer invalid",
          "content-type": "application/json",
        },
        body: '{"action":"bootstrap"}',
      }),
    );
    assert.equal(invalid.status, 403);
    assert.equal(connections, 0);
    const authorization = `Bearer ${await token()}`;
    const arbitrary = await handler(
      new Request("https://broker.invalid", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: '{"action":"cleanup","role":"postgres"}',
      }),
    );
    assert.equal(arbitrary.status, 403);
    assert.equal(connections, 0);
    const response = await handler(
      new Request("https://broker.invalid", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: '{"action":"bootstrap"}',
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.directCredentialVerified, true);
    assert.equal(body.credentialLifecycle, "phase2-vault-v1");
    assert.equal(body.password, undefined);
    assert.equal(body.expiresAt, undefined);
    assert.equal(db.verified?.role, CI.role);
    assert.equal(
      db.verified?.password,
      decodeURIComponent(new URL(body.sessionUrl).password),
    );
    assert.equal(db.closed, true);
    assert.equal(
      new URL(body.sessionUrl).searchParams.get("sslmode"),
      "verify-full",
    );
    assert.equal(new URL(body.transactionUrl).port, "6543");
    assert.equal(
      new URL(body.sessionUrl).username,
      `${CI.role}.${TARGET.project}`,
    );
    const reused = await handler(
      new Request("https://broker.invalid", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token({
            run_id: "37056114267",
            run_attempt: "3",
          })}`,
          "content-type": "application/json",
        },
        body: '{"action":"bootstrap"}',
      }),
    );
    assert.equal(reused.status, 200);
    assert.deepEqual(await reused.json(), body);
    assert.equal(db.transactionCount, 2);
    assert.deepEqual(messages, []);
  } finally {
    [console.log, console.warn, console.error] = original;
  }
});
Deno.test("direct self-test uses raw role, fixed direct endpoint and pinned verified TLS", async () => {
  const password = randomPassword();
  const ca = "synthetic already-pinned CA";
  const options = directCredentialOptions(CI.role, password, ca);
  assert.equal(options.username, CI.role);
  assert(!options.username.includes(TARGET.project));
  assert.equal(options.host, `db.${TARGET.project}.supabase.co`);
  assert.equal(options.port, 5432);
  assert.equal(options.database, "postgres");
  assert.equal(options.password, password);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca });
  assert.equal(options.debug, false);
  let closed = 0;
  for (
    const row of [
      {
        current_user: CI.role,
        current_database: "postgres",
        ssl: true,
      },
      { current_user: "postgres", current_database: "postgres", ssl: true },
      {
        current_user: CI.role,
        current_database: "wrong",
        ssl: true,
      },
      {
        current_user: CI.role,
        current_database: "postgres",
        ssl: false,
      },
    ]
  ) {
    const verification = () =>
      verifyDirectCredentials(CI.role, password, ca, (actual) => {
        assert.deepEqual(actual.ssl, options.ssl);
        return {
          query: () => Promise.resolve([row]),
          close: () => {
            closed++;
            return Promise.resolve();
          },
        };
      });
    if (
      row.current_user === CI.role &&
      row.current_database === "postgres" && row.ssl
    ) {
      await verification();
    } else await assert.rejects(verification);
  }
  await assert.rejects(() =>
    verifyDirectCredentials(CI.role, password, ca, () => ({
      query: () => Promise.reject(new Error("synthetic credential failure")),
      close: () => {
        closed++;
        return Promise.resolve();
      },
    }))
  );
  assert.equal(closed, 5);
  assert.throws(() =>
    directCredentialOptions(
      `${CI.role}.${TARGET.project}`,
      password,
      ca,
    )
  );
});
Deno.test("failed direct verification returns only generic error and retains the stable credential", async () => {
  const db = new FakeDatabase();
  db.verificationError = new Error(
    "postgresql://synthetic:synthetic-password@invalid/",
  );
  const messages: unknown[][] = [];
  const original = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...args) => {
    messages.push(args);
  };
  try {
    const handler = createHandler(() => Promise.resolve(db), fetchJwks);
    const response = await handler(
      new Request("https://broker.invalid", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token()}`,
          "content-type": "application/json",
        },
        body: '{"action":"bootstrap"}',
      }),
    );
    assert(response.status >= 400);
    assert.deepEqual(await response.json(), { error: "request_denied" });
    assert.equal(db.closed, true);
    assert.equal(db.entries[0].rolcanlogin, true);
    assert.equal(db.secrets.length, 1);
    assert(
      !db.statements.some((sql) =>
        /^(ALTER ROLE|DROP ROLE|DELETE FROM vault)/.test(sql)
      ),
    );
    assert.deepEqual(messages, []);
  } finally {
    [console.log, console.warn, console.error] = original;
  }
});
Deno.test("handler finalization requires valid OIDC and rejects arbitrary targets before connecting", async () => {
  let connections = 0;
  const handler = createHandler(() => {
    connections++;
    return Promise.resolve(new FakeDatabase());
  }, fetchJwks);
  for (
    const [jwt, body] of [
      ["invalid", { action: "finalize" }],
      [await token({ ref: "refs/heads/main" }), { action: "finalize" }],
      [await token(), { action: "finalize", role: "postgres" }],
      [await token(), { action: "finalize", secret: "provider-password" }],
      [await token(), { action: "cleanup", secret: CI.secret }],
    ] as const
  ) {
    const response = await handler(
      new Request("https://broker.invalid", {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "request_denied" });
  }
  assert.equal(connections, 0);
  const response = await handler(
    new Request("https://broker.invalid", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "finalize",
        role: CI.role,
        secret: CI.secret,
      }),
    }),
  );
  assert.deepEqual(await response.json(), { finalized: true });
});
Deno.test("production adapter wires direct verification using the same pinned CA", async () => {
  const source = await Deno.readTextFile(new URL("index.ts", import.meta.url));
  assert(source.includes("verifyDirectCredentials(role, password, ca"));
  assert(source.includes("const client = postgres(options)"));
  assert(source.includes("FROM pg_stat_ssl WHERE pid = pg_backend_pid()"));
  assert(!source.includes("rejectUnauthorized: false"));
  assert(!source.includes("checkServerIdentity"));
});
Deno.test("workflow uses OIDC with no repository database bindings and always cleans up", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "../../../.github/workflows/phase2-supabase-validation.yml",
      import.meta.url,
    ),
  );
  assert(workflow.includes("id-token: write"));
  assert(!workflow.includes("secrets.") && !workflow.includes("vars."));
  assert(workflow.includes("if: always()"));
  assert(workflow.includes("phase2-oidc-bootstrap.mjs cleanup"));
  assert(!workflow.includes("finalize"));
  const script = await Deno.readTextFile(
    new URL(
      "../../../.github/scripts/phase2-oidc-bootstrap.mjs",
      import.meta.url,
    ),
  );
  assert(script.includes("verify-full"));
  assert(script.includes("::add-mask::"));
  assert(script.includes(TARGET.caFingerprint));
  assert(script.includes(TARGET.caUrl));
  const migration = await Deno.readTextFile(
    new URL(
      "../../../apps/backend/src/database/migrations/20260922210000_arc_mainnet_fresh_baseline/migration.sql",
      import.meta.url,
    ),
  );
  // The retention whitelist must continue to agree with the canonical baseline.
  const dbSource = await Deno.readTextFile(
    new URL("database.ts", import.meta.url),
  );
  for (
    const [, name] of migration.matchAll(/CREATE (?:TABLE|TYPE) "([^"]+)"/g)
  ) assert(dbSource.includes(`"${name}"`));
});
