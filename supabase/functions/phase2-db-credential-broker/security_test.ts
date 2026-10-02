import assert from "node:assert/strict";
import {
  bootstrap,
  cleanup,
  type Database,
  type Query,
  ROLE_PRIVILEGES,
  type Row,
} from "./database.ts";
import { createHandler } from "./handler.ts";
import {
  expiresAt,
  marker,
  randomPassword,
  ROLE_TTL_SECONDS,
  roleName,
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
Deno.test("bounded role identity, expiry, random passwords and SCRAM verifier", async () => {
  assert(
    roleName({ runId: "9".repeat(20), attempt: "9".repeat(6) }).length < 63,
  );
  assert.throws(() => roleName({ runId: "9".repeat(21), attempt: "1" }));
  assert.throws(() => roleName({ runId: "postgres", attempt: "1" }));
  assert.equal(
    expiresAt(now * 1000).getTime() - now * 1000,
    ROLE_TTL_SECONDS * 1000,
  );
  assert.equal(ROLE_TTL_SECONDS, 1800);
  const first = randomPassword(), second = randomPassword();
  assert.notEqual(first, second);
  assert.equal(first.length, 64);
  const verifier = await scramVerifier(first);
  assert(verifier.startsWith("SCRAM-SHA-256$16384:"));
  assert(!verifier.includes(first));
});

class FakeDatabase implements Database {
  statements: string[] = [];
  entries: Row[] = [];
  publicTypes: Row[] = [];
  schemas: Row[] = [];
  transactionCount = 0;
  closed = false;
  async query(text: string): Promise<Row[]> {
    this.statements.push(text);
    if (text.includes("FROM pg_roles")) return this.entries;
    if (text.startsWith("ALTER ROLE")) {
      for (const entry of this.entries) entry.rolcanlogin = false;
    }
    if (text.startsWith("DROP ROLE")) this.entries = [];
    if (text.includes("FROM pg_namespace WHERE nspowner")) return this.schemas;
    if (text.includes("WHERE t.typowner")) return this.publicTypes;
    return await Promise.resolve([]);
  }
  async transaction<T>(work: (query: Query) => Promise<T>): Promise<T> {
    this.transactionCount++;
    return await work(this);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
function managedRow(): Row {
  return {
    oid: 123,
    rolname: roleName(identity),
    marker: marker(identity),
    rolvaliduntil: expiresAt(),
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  };
}
Deno.test("bootstrap privilege plan is bounded and never sends plaintext password to SQL", async () => {
  const db = new FakeDatabase(), password = randomPassword();
  await bootstrap(db, identity, password, now * 1000);
  const sql = db.statements.join("\n");
  assert(sql.includes(ROLE_PRIVILEGES));
  assert(
    sql.includes(
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    ),
  );
  assert(sql.includes("GRANT CONNECT, CREATE ON DATABASE postgres"));
  assert(sql.includes("GRANT USAGE, CREATE ON SCHEMA public"));
  assert(!sql.includes(password));
  assert(sql.includes("SCRAM-SHA-256$"));
  assert(!/GRANT (postgres|supabase_admin|pg_[a-z_]+) TO/.test(sql));
  assert(!sql.includes("ON ALL TABLES"));
});
Deno.test("bootstrap serializes runs and rejects overlap without revoking an active role", async () => {
  const db = new FakeDatabase();
  db.entries = [managedRow()];
  await assert.rejects(() =>
    bootstrap(db, { runId: "12345", attempt: "1" }, randomPassword())
  );
  assert(db.statements[0].includes("pg_advisory_xact_lock"));
  assert(
    !db.statements.some((text) =>
      /^(ALTER ROLE|CREATE ROLE|DROP ROLE)/.test(text)
    ),
  );
});
Deno.test("cleanup rejects arbitrary identities and markers, commits revoke before bounded retention", async () => {
  const db = new FakeDatabase();
  db.entries = [managedRow()];
  await assert.rejects(() => cleanup(db, identity, "postgres"));
  assert.equal(db.statements.length, 0);
  db.entries[0].marker = "not-created-by-broker";
  await assert.rejects(() => cleanup(db, identity));
  assert(!db.statements.some((sql) => sql.startsWith("ALTER ROLE")));
  db.statements = [];
  db.entries = [managedRow()];
  db.publicTypes = [{ nspname: "public", typname: "_prisma_migrations" }, {
    nspname: "public",
    typname: "__prisma_migrations",
  }];
  db.schemas = [{ nspname: `wizpay_test_${"a".repeat(32)}` }];
  await cleanup(db, identity);
  const sql = db.statements.join("\n");
  assert(sql.indexOf("NOLOGIN PASSWORD NULL") < sql.indexOf("REASSIGN OWNED"));
  assert(sql.includes("pg_terminate_backend"));
  assert(sql.includes("TO postgres"));
  assert(sql.includes(`DROP ROLE "${roleName(identity)}"`));
  assert(!sql.includes("DROP SCHEMA public"));
});
Deno.test("cleanup fails closed on unrelated schema ownership while keeping role revoked", async () => {
  const db = new FakeDatabase();
  db.entries = [managedRow()];
  db.schemas = [{ nspname: "public" }];
  await assert.rejects(() => cleanup(db, identity));
  assert.equal(db.entries[0].rolcanlogin, false);
  assert(!db.statements.some((text) => text.startsWith("DROP SCHEMA")));
});
Deno.test("termination permission failure cannot roll back committed login revocation", async () => {
  class TerminationDenied extends FakeDatabase {
    override async query(text: string): Promise<Row[]> {
      if (text.includes("pg_terminate_backend")) {
        throw new Error("Synthetic permission failure");
      }
      return await super.query(text);
    }
  }
  const db = new TerminationDenied();
  db.entries = [managedRow()];
  await assert.rejects(() => cleanup(db, identity));
  assert.equal(db.transactionCount, 2);
  assert.equal(db.entries[0].rolcanlogin, false);
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
    assert.equal(
      new URL(body.sessionUrl).searchParams.get("sslmode"),
      "verify-full",
    );
    assert.equal(new URL(body.transactionUrl).port, "6543");
    assert.equal(
      new URL(body.sessionUrl).username,
      `${roleName(identity)}.${TARGET.project}`,
    );
    assert.deepEqual(messages, []);
  } finally {
    [console.log, console.warn, console.error] = original;
  }
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
