import type { Row } from "./database.ts";
import { managedIdentity, requireCondition, TARGET } from "./security.ts";

export function directCredentialOptions(
  role: string,
  password: string,
  ca: string,
) {
  managedIdentity(role);
  requireCondition(/^[A-Za-z0-9_-]{64}$/.test(password) && ca.length > 0);
  return {
    host: `db.${TARGET.project}.supabase.co`,
    port: 5432,
    database: "postgres",
    username: role, // Direct PostgreSQL never uses the pooler's project suffix.
    password,
    ssl: { rejectUnauthorized: true as const, ca },
    prepare: false,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
    onnotice: () => undefined,
    debug: false,
  };
}

interface CredentialClient {
  query(): Promise<Row[]>;
  close(): Promise<void>;
}

export async function verifyDirectCredentials(
  role: string,
  password: string,
  ca: string,
  connect: (
    options: ReturnType<typeof directCredentialOptions>,
  ) => CredentialClient,
): Promise<void> {
  // A fresh connection authenticates the password; SET ROLE on the privileged
  // connection would prove neither SCRAM authentication nor credential validity.
  const client = connect(directCredentialOptions(role, password, ca));
  try {
    const rows = await client.query();
    requireCondition(
      rows.length === 1 && rows[0].current_user === role &&
        rows[0].current_database === "postgres" && rows[0].ssl === true,
    );
  } finally {
    await client.close();
  }
}
