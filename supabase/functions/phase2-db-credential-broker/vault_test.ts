import assert from "node:assert/strict";
import {
  bootstrap,
  cleanup,
  finalize,
  ROLE_PRIVILEGES,
  type Row,
} from "./database.ts";
import { CI, randomPassword } from "./security.ts";
import { FakeDatabase, managedRow, SECRET_ID } from "./test-database.ts";

function existing() {
  const db = new FakeDatabase();
  db.entries = [managedRow()];
  db.secrets = [{
    id: SECRET_ID,
    name: CI.secret,
    decrypted_secret: randomPassword(),
  }];
  return db;
}

Deno.test("first bootstrap atomically creates only fixed CI role and parameterized Vault secret", async () => {
  const db = new FakeDatabase();
  const result = await bootstrap(db);
  assert.equal(result.role, CI.role);
  const sql = db.statements.join("\n");
  assert.equal(
    db.statements.filter((text) => text.startsWith("CREATE ROLE")).length,
    1,
  );
  assert(sql.includes(`CREATE ROLE "${CI.role}" WITH ${ROLE_PRIVILEGES}`));
  assert(sql.includes(`COMMENT ON ROLE "${CI.role}" IS '${CI.marker}'`));
  assert(sql.includes("SET LOCAL password_encryption = 'scram-sha-256'"));
  assert(sql.includes("SCRAM-SHA-256$"));
  assert(!sql.includes("VALID UNTIL"));
  assert(!sql.includes(result.password));
  assert.equal(
    db.statements.filter((text) => text.includes("vault.create_secret")).length,
    1,
  );
  const create = db.statements.indexOf(
    "SELECT vault.create_secret($1, $2, $3) AS id",
  );
  assert.equal(db.parameters[create][0], result.password);
  assert.equal(db.parameters[create][1], CI.secret);
  assert(db.statements[0].includes("pg_advisory_xact_lock"));
  assert.equal(db.verified?.password, result.password);
  assert.equal(db.transactionCount, 1);
  assert(!/GRANT (postgres|supabase_admin|pg_[a-z_]+) TO/.test(sql));
  assert(!sql.includes("ON ALL TABLES"));
});
Deno.test("second bootstrap reuses Vault password without CREATE, ALTER, rotation or expiry", async () => {
  const db = new FakeDatabase();
  const first = await bootstrap(db);
  db.statements = [];
  db.parameters = [];
  const second = await bootstrap(db);
  assert.equal(second.password, first.password);
  assert.equal(db.secrets.length, 1);
  assert(
    !db.statements.some((text) =>
      /^(CREATE ROLE|ALTER ROLE|DROP ROLE|DELETE)/.test(text)
    ),
  );
  assert(
    !db.statements.some((text) =>
      text.includes("create_secret") || text.includes("update_secret")
    ),
  );
  const read = db.statements.findIndex((text) =>
    text.includes("FROM vault.decrypted_secrets")
  );
  assert(read >= 0);
  assert.deepEqual(db.parameters[read], [SECRET_ID, CI.secret]);
  assert.equal(db.verified?.password, first.password);
});
Deno.test("partial role-only or Vault-only state fails closed without decrypting or repairing", async () => {
  for (const missing of ["role", "secret"]) {
    const db = existing();
    if (missing === "role") db.entries = [];
    else db.secrets = [];
    await assert.rejects(() => bootstrap(db));
    assert(
      !db.statements.some((sql) =>
        /^(CREATE ROLE|ALTER ROLE|DROP ROLE|GRANT|DELETE)/.test(sql)
      ),
    );
    assert(
      !db.statements.some((sql) =>
        sql.includes("decrypted_secret") || sql.includes("create_secret")
      ),
    );
    assert.equal(db.verified, undefined);
  }
});
Deno.test("marker, login, expiry, role configuration and elevated flags fail closed before secret decryption", async () => {
  for (
    const change of [
      { marker: "unrelated" },
      { rolname: "postgres" },
      { rolcanlogin: false },
      { rolinherit: true },
      { rolvaliduntil: "2030-01-01" },
      { rolconfig: ["role=postgres"] },
      ...[
        "rolsuper",
        "rolcreatedb",
        "rolcreaterole",
        "rolreplication",
        "rolbypassrls",
      ].map((flag) => ({ [flag]: true })),
    ]
  ) {
    const db = existing();
    Object.assign(db.entries[0], change);
    await assert.rejects(() => bootstrap(db));
    assert(
      !db.statements.some((sql) =>
        sql.includes("FROM vault.decrypted_secrets") || sql.startsWith("GRANT")
      ),
    );
    assert.equal(db.verified, undefined);
  }
});
Deno.test("unexpected memberships fail closed while PostgreSQL reverse grants are permitted", async () => {
  for (
    const member of [
      {
        role: "postgres",
        member: CI.role,
        admin_option: false,
        inherit_option: false,
        set_option: true,
      },
      {
        role: CI.role,
        member: "attacker",
        admin_option: false,
        inherit_option: true,
        set_option: true,
      },
      {
        role: CI.role,
        member: "supabase_admin",
        admin_option: false,
        inherit_option: true,
        set_option: true,
      },
      {
        role: CI.role,
        member: "unrelated",
        admin_option: false,
        inherit_option: false,
        set_option: true,
      },
    ]
  ) {
    const db = existing();
    db.memberships = [member];
    await assert.rejects(() => bootstrap(db));
    assert(
      !db.statements.some((sql) =>
        sql.includes("FROM vault.decrypted_secrets")
      ),
    );
  }
  const db = existing();
  db.memberships = [{
    role: CI.role,
    member: "postgres",
    admin_option: true,
    inherit_option: true,
    set_option: true,
  }];
  await bootstrap(db);
});
Deno.test("effective Vault/provider access or unexpected ACLs fail closed without weakening PUBLIC grants", async () => {
  for (
    const flag of ["vault_blocked", "provider_blocked", "privileges_expected"]
  ) {
    const db = existing();
    db.isolation[flag] = false;
    await assert.rejects(() => bootstrap(db));
    assert(
      !db.statements.some((sql) =>
        sql.includes("FROM vault.decrypted_secrets")
      ),
    );
    assert(!db.statements.some((sql) => /^(REVOKE|GRANT)/.test(sql)));
  }
  const db = new FakeDatabase();
  db.isolation.vault_blocked = false;
  await assert.rejects(() => bootstrap(db));
  assert.deepEqual(db.entries, []);
  assert.deepEqual(db.secrets, []);
});
Deno.test("malformed/duplicate named Vault secret fails closed without rotating anything", async () => {
  const invalid = existing();
  invalid.secrets[0].decrypted_secret = "invalid";
  await assert.rejects(() => bootstrap(invalid));
  const duplicate = existing();
  duplicate.secrets.push({ ...duplicate.secrets[0] });
  await assert.rejects(() => bootstrap(duplicate));
  for (const db of [invalid, duplicate]) {
    assert(!db.statements.some((sql) => /^(CREATE ROLE|ALTER ROLE)/.test(sql)));
  }
});
Deno.test("Vault storage failure rolls back new role; direct self-test only follows successful commit", async () => {
  class VaultDenied extends FakeDatabase {
    override async query(
      text: string,
      parameters: (string | number)[] = [],
    ): Promise<Row[]> {
      if (text.includes("vault.create_secret")) {
        throw new Error("Synthetic Vault denial");
      }
      return await super.query(text, parameters);
    }
  }
  const db = new VaultDenied();
  await assert.rejects(() => bootstrap(db));
  assert.deepEqual(db.entries, []);
  assert.deepEqual(db.secrets, []);
  assert.equal(db.verified, undefined);
});
Deno.test("normal cleanup preserves role/password/Vault secret, removes isolated schemas and reassigns canonical objects", async () => {
  const db = existing();
  const password = db.secrets[0].decrypted_secret;
  db.schemas = [{ nspname: `wizpay_test_${"a".repeat(32)}` }];
  db.relations = [{ nspname: "public", relname: "Task", relkind: "r" }];
  db.publicTypes = [{ nspname: "public", typname: "_prisma_migrations" }, {
    nspname: "public",
    typname: "__prisma_migrations",
  }];
  await cleanup(db, CI.role);
  assert.equal(db.entries[0].rolcanlogin, true);
  assert.equal(db.secrets[0].decrypted_secret, password);
  assert.equal(db.schemas.length, 0);
  const sql = db.statements.join("\n");
  assert(sql.includes("pg_terminate_backend"));
  assert(sql.includes(`DROP SCHEMA "wizpay_test_${"a".repeat(32)}" CASCADE`));
  assert(sql.includes(`REASSIGN OWNED BY "${CI.role}" TO postgres`));
  assert(
    !/ALTER ROLE|DROP ROLE|DROP OWNED|DELETE FROM vault|update_secret|create_secret|decrypted_secret/
      .test(sql),
  );
});
Deno.test("cleanup rejects unexpected ownership and targets without modifying stable credentials", async () => {
  for (
    const changes of [
      { schemas: [{ nspname: "public" }] },
      {
        relations: [{ nspname: "public", relname: "unrelated", relkind: "r" }],
      },
      { publicTypes: [{ nspname: "auth", typname: "User" }] },
      { functions: [{ oid: 123 }] },
      { owners: [{ expected_catalog: false }] },
    ]
  ) {
    const db = existing();
    Object.assign(db, changes);
    await assert.rejects(() => cleanup(db));
    assert.equal(db.entries[0].rolcanlogin, true);
    assert(!db.statements.some((sql) => sql.startsWith("REASSIGN OWNED")));
  }
  const db = existing();
  await assert.rejects(() => cleanup(db, "postgres"));
  assert.equal(db.statements.length, 0);
});
Deno.test("finalize targets only fixed role and named secret, preserving unrelated Vault entries", async () => {
  const db = existing();
  db.secrets.push({
    id: "87654321-4321-4321-8321-cba987654321",
    name: "unrelated",
    decrypted_secret: "synthetic",
  });
  await finalize(db, CI.role, CI.secret);
  assert.equal(db.entries.length, 0);
  assert.deepEqual(db.secrets.map((row) => row.name), ["unrelated"]);
  const sql = db.statements.join("\n");
  assert(
    sql.indexOf("NOLOGIN PASSWORD NULL") < sql.indexOf("pg_terminate_backend"),
  );
  assert(sql.indexOf("REASSIGN OWNED") < sql.indexOf("DROP OWNED"));
  assert(sql.includes(`DROP ROLE "${CI.role}"`));
  assert(
    sql.includes(
      "DELETE FROM vault.secrets WHERE id = $1::uuid AND name = $2 RETURNING id",
    ),
  );
  assert.equal(db.transactionCount, 2);
  await finalize(db); // Fully absent pair is an idempotent no-op.
});
Deno.test("arbitrary finalization targets are rejected before SQL", async () => {
  for (
    const [role, secret] of [
      ["postgres", CI.secret],
      [CI.role, "provider-password"],
      [null, CI.secret],
      [CI.role, null],
    ]
  ) {
    const db = existing();
    await assert.rejects(() => finalize(db, role, secret));
    assert.equal(db.statements.length, 0);
  }
});
Deno.test("finalization failure cannot roll back committed revocation or delete the Vault secret", async () => {
  class TerminationDenied extends FakeDatabase {
    override async query(
      text: string,
      parameters: (string | number)[] = [],
    ): Promise<Row[]> {
      if (text.includes("pg_terminate_backend")) {
        throw new Error("Synthetic permission failure");
      }
      return await super.query(text, parameters);
    }
  }
  const source = existing();
  const db = new TerminationDenied();
  db.entries = source.entries;
  db.secrets = source.secrets;
  await assert.rejects(() => finalize(db));
  assert.equal(db.transactionCount, 2);
  assert.equal(db.entries[0].rolcanlogin, false);
  assert.equal(db.secrets.length, 1);
});
Deno.test("unrelated ownership blocks finalization while login stays revoked", async () => {
  const db = existing();
  db.schemas = [{ nspname: "public" }];
  await assert.rejects(() => finalize(db));
  assert.equal(db.entries[0].rolcanlogin, false);
  assert.equal(db.secrets.length, 1);
  assert(!db.statements.some((sql) => sql.startsWith("DROP ROLE")));
});
