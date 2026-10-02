import {
  CI,
  randomPassword,
  requireCondition,
  scramVerifier,
} from "./security.ts";

export type Row = Record<string, unknown>;
export interface Query {
  query(text: string, parameters?: (string | number)[]): Promise<Row[]>;
}
export interface Database extends Query {
  transaction<T>(work: (query: Query) => Promise<T>): Promise<T>;
  verifyCredentials(role: string, password: string): Promise<void>;
  close(): Promise<void>;
}
const lock = (query: Query) =>
  query.query("SELECT pg_advisory_xact_lock(504220260002)");
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const ROLE_PRIVILEGES =
  "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT";
const TABLES = [
  "Task",
  "TaskLog",
  "TaskUnit",
  "TaskTransaction",
  "UserWallet",
  "Invoice",
  "InvoicePayment",
  "ExecutionIntent",
  "BridgeTransaction",
  "Activity",
  "ActivityAuthSession",
  "WalletAuthChallenge",
  "VerifiedSwapTransaction",
  "ActivitySyncState",
  "_prisma_migrations",
];
const ENUMS = [
  "InvoiceStatus",
  "InvoicePaymentStatus",
  "InvoiceSettlementKind",
  "ExecutionIntentOperation",
  "ExecutionIntentRoute",
  "ExecutionIntentStatus",
];
// Only fixed names are accepted; neither OIDC claims nor request inputs select
// a role or Vault record. Inventory never reads decrypted values.
async function state(query: Query) {
  const roles = await query.query(
    "SELECT oid, rolname, rolvaliduntil, rolcanlogin, rolinherit, rolconfig, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1",
    [CI.role],
  );
  const secrets = await query.query(
    "SELECT id FROM vault.secrets WHERE name = $1",
    [CI.secret],
  );
  requireCondition(roles.length <= 1 && secrets.length <= 1);
  requireCondition(roles.length === secrets.length);
  if (secrets[0]) {
    requireCondition(
      typeof secrets[0].id === "string" &&
        /^[a-f0-9-]{36}$/.test(secrets[0].id),
    );
  }
  return { role: roles[0], secret: secrets[0] };
}
function assertManaged(row: Row, allowRevoked = false) {
  requireCondition(row.rolname === CI.role && row.marker === CI.marker);
  requireCondition(
    row.rolcanlogin === true || (allowRevoked && row.rolcanlogin === false),
  );
  requireCondition(
    row.rolinherit === false && row.rolvaliduntil === null &&
      row.rolconfig === null,
  );
  for (
    const flag of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
      "rolbypassrls",
    ]
  ) {
    requireCondition(row[flag] === false);
  }
}
export async function assertCiMemberships(query: Query) {
  // PostgreSQL can retain separate automatic ADMIN and explicit INHERIT/SET
  // rows from different grantors. Permit only CI -> postgres, never a parent
  // membership of CI, regardless of those reverse-grant option combinations.
  const memberships = await query.query(
    "SELECT r.rolname AS role, u.rolname AS member, m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE r.rolname = $1 OR u.rolname = $1",
    [CI.role],
  );
  for (const member of memberships) {
    requireCondition(
      member.role === CI.role && member.member === "postgres" &&
        typeof member.admin_option === "boolean" &&
        typeof member.inherit_option === "boolean" &&
        typeof member.set_option === "boolean",
    );
  }
}
// Check effective permissions, including PUBLIC, rather than trusting REVOKE.
// Schema USAGE is necessary for invoking even PUBLIC-executable Vault functions.
// Never alter shared PUBLIC/provider ACLs to accommodate this CI role.
export async function assertCiIsolation(query: Query) {
  const rows = await query.query(
    `
    SELECT
      NOT has_schema_privilege($1::regrole::oid, 'vault', 'USAGE,CREATE') AS vault_blocked,
      NOT EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
          AND NOT (n.nspname ~ '^wizpay_test_[a-f0-9]{32}$' AND n.nspowner = $1::regrole::oid)
          AND has_schema_privilege($1::regrole::oid, n.oid, 'USAGE,CREATE')
      ) AS provider_blocked,
      NOT EXISTS (
        SELECT 1 FROM pg_database d, LATERAL aclexplode(d.datacl) a
        WHERE a.grantee = $1::regrole::oid AND
          (d.datname <> 'postgres' OR a.privilege_type NOT IN ('CONNECT', 'CREATE') OR a.is_grantable)
        UNION ALL
        SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
        WHERE a.grantee = $1::regrole::oid AND n.nspowner <> a.grantee AND
          (n.nspname <> 'public' OR a.privilege_type NOT IN ('USAGE', 'CREATE') OR a.is_grantable)
        UNION ALL
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
          LATERAL aclexplode(c.relacl) a
        WHERE a.grantee = $1::regrole::oid AND c.relowner <> a.grantee AND
          (n.nspname <> 'public' OR c.relkind <> 'r' OR c.relname NOT IN (${
      TABLES.map(literal).join(",")
    })
           OR a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') OR a.is_grantable)
        UNION ALL
        SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a
        WHERE a.grantee = $1::regrole::oid
        UNION ALL
        SELECT 1 FROM pg_type t, LATERAL aclexplode(t.typacl) a
        WHERE a.grantee = $1::regrole::oid AND t.typowner <> a.grantee AND
          (t.typnamespace <> 'public'::regnamespace OR t.typname NOT IN (${
      ENUMS.map(literal).join(",")
    })
           OR a.privilege_type <> 'USAGE' OR a.is_grantable)
        UNION ALL
        SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
        WHERE a.grantee = $1::regrole::oid
        UNION ALL
        SELECT 1 FROM pg_database d WHERE d.datdba = $1::regrole::oid
        UNION ALL
        SELECT 1 FROM pg_namespace n WHERE n.nspowner = $1::regrole::oid
          AND n.nspname !~ '^wizpay_test_[a-f0-9]{32}$'
      ) AS privileges_expected
  `,
    [CI.role],
  );
  requireCondition(
    rows.length === 1 && rows[0].vault_blocked === true &&
      rows[0].provider_blocked === true && rows[0].privileges_expected === true,
  );
}
async function validate(query: Query, row: Row, allowRevoked = false) {
  assertManaged(row, allowRevoked);
  await assertCiMemberships(query);
  await assertCiIsolation(query);
}
async function terminateSessions(query: Query) {
  await query.query(
    "SELECT pg_terminate_backend(pid, 1000) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
    [CI.role],
  );
  const remaining = await query.query(
    "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
    [CI.role],
  );
  requireCondition(remaining.length === 0);
}
async function retainCanonicalObjects(query: Query, row: Row) {
  const schemas = await query.query(
    "SELECT nspname FROM pg_namespace WHERE nspowner = $1",
    [Number(row.oid)],
  );
  for (const schema of schemas) {
    requireCondition(
      typeof schema.nspname === "string" &&
        /^wizpay_test_[a-f0-9]{32}$/.test(schema.nspname),
    );
    await query.query(
      `DROP SCHEMA ${identifier(String(schema.nspname))} CASCADE`,
    );
  }
  const relations = await query.query(
    "SELECT c.relname, c.relkind, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relowner = $1 AND c.relkind NOT IN ('i', 'I')",
    [Number(row.oid)],
  );
  for (const relation of relations) {
    requireCondition(
      relation.nspname === "public" && relation.relkind === "r" &&
        TABLES.includes(String(relation.relname)),
    );
  }
  const types = await query.query(
    "SELECT t.typname, n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typowner = $1",
    [Number(row.oid)],
  );
  for (const type of types) {
    requireCondition(
      type.nspname === "public" &&
        ([...TABLES, ...ENUMS].includes(String(type.typname)) ||
          [...TABLES, ...ENUMS].includes(
            String(type.typname).replace(/^_/, ""),
          )),
    );
  }
  const functions = await query.query(
    "SELECT oid FROM pg_proc WHERE proowner = $1",
    [Number(row.oid)],
  );
  requireCondition(functions.length === 0);
  // REASSIGN OWNED spans other catalogs too. Reject unexpected ownership
  // before transferring operators/extensions/foreign servers/default ACLs.
  const owners = await query.query(
    "SELECT dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid IN ('pg_class'::regclass, 'pg_type'::regclass) AS expected_catalog FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = $1::oid AND deptype = 'o'",
    [Number(row.oid)],
  );
  requireCondition(owners.every((owner) => owner.expected_catalog === true));
  await query.query(`REASSIGN OWNED BY ${identifier(CI.role)} TO postgres`);
}
async function minimumGrants(query: Query) {
  // Retain PostgreSQL 17's automatic creator ADMIN grant; explicitly granting
  // ADMIN back to oneself as a nonsuperuser is rejected by PostgreSQL.
  // Reverse INHERIT/SET gives postgres cleanup access, never the CI login.
  await query.query(
    `GRANT ${identifier(CI.role)} TO postgres WITH INHERIT TRUE, SET TRUE`,
  );
  await query.query(
    `GRANT CONNECT, CREATE ON DATABASE postgres TO ${identifier(CI.role)}`,
  );
  await query.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(CI.role)}`,
  );
  const tables = await query.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  for (const table of tables) {
    requireCondition(TABLES.includes(String(table.tablename)));
    await query.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${
        identifier(String(table.tablename))
      } TO ${identifier(CI.role)}`,
    );
  }
  const enums = await query.query(
    "SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'",
  );
  for (const type of enums) {
    requireCondition(ENUMS.includes(String(type.typname)));
    await query.query(
      `GRANT USAGE ON TYPE public.${identifier(String(type.typname))} TO ${
        identifier(CI.role)
      }`,
    );
  }
}
export async function bootstrap(database: Database) {
  const password = await database.transaction(async (query) => {
    await lock(query);
    const current = await state(query);
    await query.query("SET LOCAL password_encryption = 'scram-sha-256'");
    let value: string;
    if (current.role) {
      requireCondition(current.secret);
      await validate(query, current.role);
      const rows = await query.query(
        "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = $1::uuid AND name = $2",
        [String(current.secret.id), CI.secret],
      );
      requireCondition(
        rows.length === 1 && typeof rows[0].decrypted_secret === "string",
      );
      value = rows[0].decrypted_secret;
      requireCondition(/^[A-Za-z0-9_-]{64}$/.test(value));
    } else {
      value = randomPassword();
      const verifier = await scramVerifier(value);
      await query.query(
        `CREATE ROLE ${identifier(CI.role)} WITH ${ROLE_PRIVILEGES} PASSWORD ${
          literal(verifier)
        }`,
      );
      await query.query(
        `COMMENT ON ROLE ${identifier(CI.role)} IS ${literal(CI.marker)}`,
      );
      // Plaintext is exclusively a bound parameter to Vault, never utility DDL.
      const stored = await query.query(
        "SELECT vault.create_secret($1, $2, $3) AS id",
        [
          value,
          CI.secret,
          "Temporary Phase 2 CI credential; delete after independent acceptance",
        ],
      );
      requireCondition(stored.length === 1 && typeof stored[0].id === "string");
    }
    await minimumGrants(query);
    const created = await state(query);
    requireCondition(created.role);
    await validate(query, created.role);
    return value;
  });
  // Role creation must commit before a separate login can authenticate it.
  // Failure leaves the matched role/Vault pair intact for explicit finalization;
  // it cannot return URLs or silently rotate an existing credential.
  await database.verifyCredentials(CI.role, password);
  return { role: CI.role, password };
}
function fixedTargets(requestedRole?: unknown, requestedSecret?: unknown) {
  requireCondition(requestedRole === undefined || requestedRole === CI.role);
  requireCondition(
    requestedSecret === undefined || requestedSecret === CI.secret,
  );
}
export async function cleanup(database: Database, requestedRole?: unknown) {
  fixedTargets(requestedRole);
  await database.transaction(async (query) => {
    await lock(query);
    const current = await state(query);
    if (!current.role) return;
    await validate(query, current.role);
    await terminateSessions(query);
    await retainCanonicalObjects(query, current.role);
    // Keep the stable login, verifier, Vault secret and expected grants. No
    // DROP OWNED here: it would remove the privileges needed by the next run.
  });
}
export async function finalize(
  database: Database,
  requestedRole?: unknown,
  requestedSecret?: unknown,
) {
  fixedTargets(requestedRole, requestedSecret);
  // Commit revocation independently so later cleanup failure cannot restore it.
  await database.transaction(async (query) => {
    await lock(query);
    const current = await state(query);
    if (!current.role) return;
    await validate(query, current.role, true);
    await query.query(
      `ALTER ROLE ${identifier(CI.role)} NOLOGIN PASSWORD NULL`,
    );
  });
  await database.transaction(async (query) => {
    await lock(query);
    const current = await state(query);
    if (!current.role) return;
    await validate(query, current.role, true);
    requireCondition(current.role.rolcanlogin === false);
    requireCondition(current.secret);
    await terminateSessions(query);
    await retainCanonicalObjects(query, current.role);
    await query.query(`DROP OWNED BY ${identifier(CI.role)}`);
    await query.query(`DROP ROLE ${identifier(CI.role)}`);
    const deleted = await query.query(
      "DELETE FROM vault.secrets WHERE id = $1::uuid AND name = $2 RETURNING id",
      [String(current.secret.id), CI.secret],
    );
    requireCondition(deleted.length === 1);
  });
}
