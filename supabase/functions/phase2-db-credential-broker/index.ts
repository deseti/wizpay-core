import postgres from "postgres";
import { X509Certificate } from "node:crypto";
import type { Database, Query } from "./database.ts";
import { verifyDirectCredentials } from "./direct-credentials.ts";
import { createHandler } from "./handler.ts";
import { requireCondition, TARGET } from "./security.ts";

async function connect(): Promise<Database> {
  // No request input, service-role key, alternate URL or credential fallback.
  requireCondition(
    Deno.env.get("SUPABASE_URL") === `https://${TARGET.project}.supabase.co`,
  );
  const binding = Deno.env.get("SUPABASE_DB_URL");
  requireCondition(binding);
  const url = new URL(binding);
  requireCondition(["postgresql:", "postgres:"].includes(url.protocol));
  requireCondition(
    url.hostname === `db.${TARGET.project}.supabase.co` &&
      (url.port || "5432") === "5432",
  );
  requireCondition(
    decodeURIComponent(url.username) === "postgres" &&
      url.pathname === "/postgres" && url.password,
  );
  const response = await fetch(TARGET.caUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  requireCondition(response.ok);
  const ca = await response.text();
  const certificate = new X509Certificate(ca);
  requireCondition(
    certificate.fingerprint256.replaceAll(":", "").toUpperCase() ===
      TARGET.caFingerprint,
  );
  requireCondition(
    certificate.ca && Date.parse(certificate.validFrom) <= Date.now() &&
      Date.parse(certificate.validTo) > Date.now(),
  );
  const sql = postgres({
    host: url.hostname,
    port: 5432,
    username: "postgres",
    password: decodeURIComponent(url.password),
    database: "postgres",
    ssl: { rejectUnauthorized: true, ca },
    prepare: false,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
    onnotice: () => undefined,
    debug: false,
  });
  try {
    const rows = await sql`SELECT current_user, current_database()`;
    requireCondition(
      rows[0].current_user === "postgres" &&
        rows[0].current_database === "postgres",
    );
    const adapter = (client: typeof sql): Query => ({
      query: async (
        text,
        parameters = [],
      ) => [...await client.unsafe(text, parameters)],
    });
    return {
      ...adapter(sql),
      verifyCredentials: (role, password) =>
        verifyDirectCredentials(role, password, ca, (options) => {
          const client = postgres(options);
          return {
            query: async () => [
              ...await client`
              SELECT current_user, current_database(), ssl
              FROM pg_stat_ssl WHERE pid = pg_backend_pid()
            `,
            ],
            close: async () => {
              await client.end({ timeout: 5 });
            },
          };
        }),
      transaction: async (work) =>
        await sql.begin(async (transaction) =>
          await work(adapter(transaction as unknown as typeof sql))
        ) as Awaited<ReturnType<typeof work>>,
      close: async () => {
        await sql.end({ timeout: 5 });
      },
    };
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
}

Deno.serve(createHandler(connect));
