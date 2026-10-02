import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  postgresUrl,
  runtimeDatabasePool,
} from '../src/database/database-connection.config';

type Environment = Record<string, string | undefined>;
export const migrationsRoot = join(__dirname, '../src/database/migrations');

export function externalTestConnection(environment: Environment) {
  if (
    environment.NODE_ENV === 'production' ||
    environment.WIZPAY_EXTERNAL_TEST_ACK !== 'ISOLATED_NONPRODUCTION_SCHEMA'
  )
    throw new Error(
      'External database tests require an explicit nonproduction schema acknowledgement.',
    );
  const value = environment.WIZPAY_EXTERNAL_TEST_DATABASE_URL;
  const url = postgresUrl(value, 'WIZPAY_EXTERNAL_TEST_DATABASE_URL');
  if (
    url.hostname !== environment.WIZPAY_EXTERNAL_TEST_TARGET_HOST ||
    decodeURIComponent(url.pathname.slice(1)) !==
      environment.WIZPAY_EXTERNAL_TEST_TARGET_DATABASE
  )
    throw new Error(
      'External test endpoint must match the separately acknowledged host and database.',
    );
  if (url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543')
    throw new Error(
      'Test setup requires a direct or session endpoint, not transaction pooling.',
    );
  const config = runtimeDatabasePool(value!, {
    WIZPAY_DATABASE_PROFILE: 'supavisor-transaction',
  });
  return config;
}

export function hasPostgresTarget(localKey: string): boolean {
  return Boolean(
    process.env[localKey] || process.env.WIZPAY_EXTERNAL_TEST_DATABASE_URL,
  );
}

/** Existing guarded local database isolation or explicitly authorized remote schema isolation. */
export async function openPostgresHarness(
  localKey: string,
  localAdminName: string,
) {
  const environment = process.env;
  const external = environment.WIZPAY_EXTERNAL_TEST_DATABASE_URL !== undefined;
  if (external && environment[localKey] !== undefined)
    throw new Error(
      'Choose exactly one local or external database test target.',
    );
  const local = environment[localKey];
  const localUrl = external ? null : postgresUrl(local, localKey);
  if (
    localUrl &&
    (!['127.0.0.1', 'localhost', '[::1]'].includes(localUrl.hostname) ||
      localUrl.pathname !== `/${localAdminName}`)
  )
    throw new Error(
      `${localKey} must target the dedicated local ${localAdminName} database.`,
    );
  const admin = new Client(
    external
      ? externalTestConnection(environment)
      : { connectionString: local },
  );
  const isolated = `wizpay_test_${randomUUID().replaceAll('-', '')}`;
  const schema = external ? isolated : 'public';
  let created = false;
  let migrationClient: Client | undefined;
  const clients: PrismaClient[] = [];
  const runtime = environment.WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL;
  let pool = external
    ? externalTestConnection(environment)
    : { connectionString: local };
  if (external && runtime !== undefined) {
    const parsed = postgresUrl(
      runtime,
      'WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL',
    );
    if (
      parsed.hostname !==
        environment.WIZPAY_EXTERNAL_TEST_RUNTIME_TARGET_HOST ||
      decodeURIComponent(parsed.pathname.slice(1)) !==
        environment.WIZPAY_EXTERNAL_TEST_TARGET_DATABASE
    )
      throw new Error(
        'External runtime test endpoint must match its separately acknowledged host and database.',
      );
    pool = runtimeDatabasePool(runtime, {
      WIZPAY_DATABASE_PROFILE: 'supavisor-transaction',
    });
  }
  const close = async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
    if (migrationClient) await migrationClient.end();
    if (created)
      await admin.query(
        external
          ? `DROP SCHEMA "${isolated}" CASCADE`
          : `DROP DATABASE "${isolated}"`,
      );
    await admin.end();
  };
  try {
    await admin.connect();
    await admin.query(
      external
        ? `CREATE SCHEMA "${isolated}"`
        : `CREATE DATABASE "${isolated}"`,
    );
    created = true;
    if (!external) {
      const url = new URL(local!);
      url.pathname = `/${isolated}`;
      pool = { connectionString: url.toString() };
    }
    // Migration setup uses one session connection, never runtime pool queries.
    migrationClient = new Client(
      external ? externalTestConnection(environment) : pool,
    );
    await migrationClient.connect();
    await migrationClient.query('BEGIN');
    await migrationClient.query(`SET LOCAL search_path TO "${schema}"`);
    for (const entry of (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await migrationClient.query(
        await readFile(
          join(migrationsRoot, entry.name, 'migration.sql'),
          'utf8',
        ),
      );
    }
    await migrationClient.query('COMMIT');
    await migrationClient.end();
    migrationClient = undefined;
    const createPrisma = () => {
      const client = new PrismaClient({
        adapter: new PrismaPg(pool, { schema }),
      });
      clients.push(client);
      return client;
    };
    const prisma = createPrisma();
    await prisma.$connect();
    return { schema, prisma, createPrisma, close };
  } catch {
    // Roll back before cleanup and do not leak driver messages with credentials.
    if (migrationClient)
      await migrationClient.query('ROLLBACK').catch(() => undefined);
    await close().catch(() => undefined);
    throw new Error(
      'Isolated PostgreSQL test setup failed; check endpoint access, TLS and schema permissions securely.',
    );
  }
}
