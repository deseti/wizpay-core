import {
  expiresAt,
  managedIdentity,
  marker,
  requireCondition,
  roleName,
  type RunIdentity,
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
async function roles(query: Query) {
  return await query.query(
    "SELECT oid, rolname, rolvaliduntil, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname ~ '^wizpay_p2_[1-9][0-9]{0,19}_[1-9][0-9]{0,5}$'",
  );
}
function assertManaged(row: Row, identity: RunIdentity) {
  requireCondition(
    row.rolname === roleName(identity) && row.marker === marker(identity),
  );
  for (
    const flag of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
      "rolbypassrls",
    ]
  ) requireCondition(row[flag] === false);
}
async function revoke(query: Query, row: Row) {
  const name = String(row.rolname);
  managedIdentity(name);
  await query.query(`ALTER ROLE ${identifier(name)} NOLOGIN PASSWORD NULL`);
}
async function terminateSessions(query: Query, row: Row) {
  const name = String(row.rolname);
  managedIdentity(name);
  await query.query(
    "SELECT pg_terminate_backend(pid, 1000) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
    [name],
  );
  // A false termination result can be a harmless PID-exit race; require the
  // fresh session inventory to be empty before ownership/drop operations.
  const remaining = await query.query(
    "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
    [name],
  );
  requireCondition(remaining.length === 0);
}
async function remove(query: Query, row: Row) {
  const name = String(row.rolname);
  const schemas = await query.query(
    "SELECT nspname FROM pg_namespace WHERE nspowner = $1",
    [Number(row.oid)],
  );
  for (const schema of schemas) {
    requireCondition(
      typeof schema.nspname === "string" &&
        /^wizpay_test_[a-f0-9]{32}$/.test(schema.nspname),
    );
    await query.query(`DROP SCHEMA ${identifier(schema.nspname)} CASCADE`);
  }
  // Only canonical public tables/types may be intentionally retained. Reject
  // unexpected ownership instead of reassigning unrelated provider objects.
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
  await query.query(`REASSIGN OWNED BY ${identifier(name)} TO postgres`);
  await query.query(`DROP OWNED BY ${identifier(name)}`);
  await query.query(`DROP ROLE ${identifier(name)}`);
}
export async function bootstrap(
  database: Database,
  identity: RunIdentity,
  password: string,
  now = Date.now(),
) {
  const name = roleName(identity), expiry = expiresAt(now);
  const verifier = await scramVerifier(password);
  await database.transaction(async (query) => {
    await lock(query);
    for (const row of await roles(query)) {
      const owner = managedIdentity(String(row.rolname));
      assertManaged(row, owner);
      requireCondition(new Date(String(row.rolvaliduntil)).getTime() <= now);
      await revoke(query, row);
      await terminateSessions(query, row);
      await remove(query, row);
    }
    await query.query("SET LOCAL password_encryption = 'scram-sha-256'");
    await query.query(
      `CREATE ROLE ${identifier(name)} WITH ${ROLE_PRIVILEGES} VALID UNTIL ${
        literal(expiry.toISOString())
      } PASSWORD ${literal(verifier)}`,
    );
    await query.query(
      `COMMENT ON ROLE ${identifier(name)} IS ${literal(marker(identity))}`,
    );
    // This direction lets postgres terminate the role's sessions and reassign
    // its objects; the login never joins postgres or any platform role.
    await query.query(
      `GRANT ${identifier(name)} TO postgres WITH INHERIT TRUE, SET TRUE`,
    );
    await query.query(
      `GRANT CONNECT, CREATE ON DATABASE postgres TO ${identifier(name)}`,
    );
    await query.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(name)}`,
    );
    // A rerun needs access to the retained baseline; enumerate its objects,
    // never grant on all provider tables or platform/auth schemas.
    const tables = await query.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    for (const table of tables) {
      requireCondition(TABLES.includes(String(table.tablename)));
      await query.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${
          identifier(String(table.tablename))
        } TO ${identifier(name)}`,
      );
    }
    const enums = await query.query(
      "SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'",
    );
    for (const type of enums) {
      requireCondition(ENUMS.includes(String(type.typname)));
      await query.query(
        `GRANT USAGE ON TYPE public.${identifier(String(type.typname))} TO ${
          identifier(name)
        }`,
      );
    }
  });
  return { role: name, expiresAt: expiry.toISOString() };
}
export async function cleanup(
  database: Database,
  identity: RunIdentity,
  requestedRole?: unknown,
) {
  const name = roleName(identity);
  requireCondition(requestedRole === undefined || requestedRole === name);
  // Commit revocation first: a retention/ownership failure must not restore
  // login capability. A second locked transaction finishes bounded cleanup.
  await database.transaction(async (query) => {
    await lock(query);
    const row = (await roles(query)).find((candidate) =>
      candidate.rolname === name
    );
    if (row) {
      assertManaged(row, identity);
      await revoke(query, row);
    }
  });
  await database.transaction(async (query) => {
    await lock(query);
    const row = (await roles(query)).find((candidate) =>
      candidate.rolname === name
    );
    if (row) {
      assertManaged(row, identity);
      requireCondition(row.rolcanlogin === false);
      await terminateSessions(query, row);
      await remove(query, row);
    }
  });
}
