import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { stripVTControlCharacters } from 'node:util';
import { Client } from 'pg';
import {
  migrationDatabaseUrl,
  postgresUrl,
  runtimeDatabasePool,
} from '../src/database/database-connection.config';
import { checkPostgresCatalog } from './check-postgres-catalog';
import { externalTestConnection, migrationsRoot } from './postgres-harness';

// Child output stays in memory. Only selected nonsecret results are published;
// driver errors, environment values and connection strings are never printed.
const environment: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
let stage = 'configuration';
let certificateDirectory: string | undefined;

function command(label: string, args: string[], pendingAllowed = false) {
  stage = label;
  const result = spawnSync('npm', args, {
    env: environment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  const output = stripVTControlCharacters(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
  const pending =
    pendingAllowed &&
    result.status === 1 &&
    /not yet been applied/.test(output);
  const summaries = output
    .split('\n')
    .filter((line) => /^(Test Suites:|Tests:)/.test(line));
  // These summaries contain only counts and outcome words, never test output.
  const safeSummaries = summaries.filter((line) =>
    /^(Test Suites|Tests):\s+(?:\d+ (?:passed|failed|skipped),\s+)+\d+ total$/.test(
      line,
    ),
  );
  console.log(
    JSON.stringify({
      stage,
      exitCode: result.status,
      result: pending
        ? 'PENDING (expected on a clean database)'
        : result.status === 0
          ? 'PASS'
          : 'FAIL',
      ...(safeSummaries.length ? { summaries: safeSummaries } : {}),
    }),
  );
  assert(
    !result.error && (result.status === 0 || pending),
    'Validation command failed.',
  );
  return safeSummaries;
}

async function normalizedBindings() {
  assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED === '0', false);
  assert.equal(environment.NODE_ENV === 'production', false);
  assert.equal(environment.WIZPAY_DATABASE_PROFILE, 'supavisor-transaction');
  assert.equal(environment.WIZPAY_MIGRATION_DATABASE_MODE, 'session');
  assert.equal(environment.WIZPAY_ARC_NETWORK, 'arc-mainnet');
  assert.equal(environment.WIZPAY_MIGRATION_NETWORK, 'arc-mainnet');
  assert.equal(environment.WIZPAY_EXTERNAL_TEST_TARGET_DATABASE, 'postgres');
  for (const name of [
    'DATABASE_URL',
    'DIRECT_URL',
    'EXECUTION_INTENT_TEST_DATABASE_URL',
    'PHASE7_TEST_DATABASE_URL',
  ])
    assert.equal(environment[name], undefined);
  const certificate = environment.WIZPAY_EXTERNAL_TEST_CA_PEM;
  if (certificate) {
    assert(certificate.includes('-----BEGIN CERTIFICATE-----'));
    certificateDirectory = await mkdtemp(join(tmpdir(), 'wizpay-phase2-ca-'));
    await writeFile(join(certificateDirectory, 'root.crt'), certificate, {
      mode: 0o600,
    });
  }
  for (const name of [
    'WIZPAY_EXTERNAL_TEST_DATABASE_URL',
    'WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL',
  ]) {
    const url = postgresUrl(environment[name], name);
    assert(url.hostname.endsWith('.pooler.supabase.com'));
    // Supply the missing secure option in-process; never weaken an existing one.
    if (!url.searchParams.has('sslmode'))
      url.searchParams.set('sslmode', 'verify-full');
    if (certificateDirectory)
      url.searchParams.set(
        'sslrootcert',
        join(certificateDirectory, 'root.crt'),
      );
    environment[name] = url.toString();
  }
  const setup = postgresUrl(
    environment.WIZPAY_EXTERNAL_TEST_DATABASE_URL,
    'setup binding',
  );
  const runtime = postgresUrl(
    environment.WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL,
    'runtime binding',
  );
  assert.equal(setup.port || '5432', '5432');
  assert.equal(runtime.port, '6543');
  assert.equal(
    runtime.hostname,
    environment.WIZPAY_EXTERNAL_TEST_RUNTIME_TARGET_HOST,
  );
  assert.equal(runtime.pathname, setup.pathname);
  assert.equal(runtime.username, setup.username);
  environment.ARC_MAINNET_MIGRATION_DATABASE_URL =
    environment.WIZPAY_EXTERNAL_TEST_DATABASE_URL;
  migrationDatabaseUrl(environment);
  return [
    externalTestConnection(environment),
    runtimeDatabasePool(
      environment.WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL!,
      environment,
    ),
  ];
}

async function applicationTables() {
  const tables: string[] = [];
  for (const entry of (
    await readdir(migrationsRoot, { withFileTypes: true })
  ).filter((entry) => entry.isDirectory())) {
    const sql = await readFile(
      join(migrationsRoot, entry.name, 'migration.sql'),
      'utf8',
    );
    for (const [, name] of sql.matchAll(/CREATE TABLE "([^"]+)"/g))
      tables.push(name);
  }
  return tables;
}

async function assertNoPublicData(client: Client) {
  for (const name of await applicationTables()) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) FROM public."${name.replaceAll('"', '""')}"`,
    );
    assert.equal(
      result.rows[0].count,
      '0',
      'Validation target must contain no application data.',
    );
  }
}

async function main() {
  const configurations = await normalizedBindings();
  let clean = false;
  let initialTestSchemas: string[] = [];
  for (let index = 0; index < configurations.length; index++) {
    stage = index === 0 ? 'session preflight' : 'transaction preflight';
    const config = configurations[index];
    const client = new Client(config);
    try {
      await client.connect();
      const stream = (
        client as unknown as { connection: { stream: TLSSocket } }
      ).connection.stream;
      assert.equal(stream.authorized, true);
      const version = (
        await client.query<{ server_version: string }>('SHOW server_version')
      ).rows[0].server_version;
      const numericVersion = Number(
        (
          await client.query<{ server_version_num: string }>(
            'SHOW server_version_num',
          )
        ).rows[0].server_version_num,
      );
      assert(numericVersion >= 170000 && numericVersion < 180000);
      if (index === 0) {
        const privileges = (
          await client.query<{
            schema_create: boolean;
            public_create: boolean;
            public_usage: boolean;
          }>(
            "SELECT has_database_privilege(current_database(), 'CREATE') AS schema_create, has_schema_privilege('public', 'CREATE') AS public_create, has_schema_privilege('public', 'USAGE') AS public_usage",
          )
        ).rows[0];
        assert(Object.values(privileges).every(Boolean));
        const tables = (
          await client.query<{ tablename: string }>(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
          )
        ).rows;
        clean = tables.length === 0;
        if (!clean) {
          // A rerun is allowed only for the canonical, fully applied empty schema.
          await checkPostgresCatalog(client, 'public', true);
          assert.equal(tables.length, (await applicationTables()).length + 1);
          await assertNoPublicData(client);
        }
        initialTestSchemas = (
          await client.query<{ nspname: string }>(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'wizpay_test_%' ORDER BY nspname",
          )
        ).rows.map((row) => row.nspname);
      }
      console.log(
        JSON.stringify({
          stage,
          result: 'PASS',
          host: config.host,
          port: config.port,
          database: config.database,
          postgresVersion: version,
          tlsMode: 'verify-full',
          certificateAuthorized: true,
          tlsProtocol: stream.getProtocol(),
          poolMax: config.max,
        }),
      );
    } finally {
      await client.end();
    }
  }

  command('Prisma validate', ['exec', '--', 'prisma', 'validate']);
  if (clean)
    command('clean catalog preflight', [
      'exec',
      '--',
      'ts-node',
      'test/check-postgres-catalog.ts',
      '--preflight',
    ]);
  command(
    'migration status before',
    ['exec', '--', 'prisma', 'migrate', 'status'],
    clean,
  );
  command('migration deploy', ['run', 'prisma:migrate:arc-mainnet']);
  command('migration status after', [
    'exec',
    '--',
    'prisma',
    'migrate',
    'status',
  ]);
  command('migration deploy repeat', ['run', 'prisma:migrate:arc-mainnet']);

  stage = 'catalog and migration history';
  const catalog = new Client(configurations[0]);
  try {
    await catalog.connect();
    const result = await checkPostgresCatalog(catalog, 'public', true);
    const publicTables = Number(
      (
        await catalog.query<{ count: string }>(
          "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
        )
      ).rows[0].count,
    );
    assert.equal(publicTables, result.tables + 1);
    const migrations = (
      await catalog.query<{ migration_name: string }>(
        'SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).rows.map((row) => row.migration_name);
    console.log(
      JSON.stringify({
        stage,
        result: 'PASS',
        ...result,
        publicTables,
        migrations,
        constraintsIntact: true,
      }),
    );
    await assertNoPublicData(catalog);
  } finally {
    await catalog.end();
  }

  const summaries = command(
    'three live PostgreSQL suites (transaction runtime)',
    [
      'run',
      'test',
      '--',
      '--runInBand',
      '--runTestsByPath',
      'src/database/persistence.postgres.spec.ts',
      'src/execution-intent/execution-intent.postgres.spec.ts',
      'src/phase7/phase7-offline-rehearsal.postgres.spec.ts',
    ],
  );
  assert(
    summaries.some((line) => /Test Suites:\s+3 passed, 3 total/.test(line)),
  );
  assert(summaries.some((line) => /Tests:\s+10 passed, 10 total/.test(line)));
  stage = 'test schema cleanup';
  const cleanupCheck = new Client(configurations[0]);
  try {
    await cleanupCheck.connect();
    const schemas = (
      await cleanupCheck.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'wizpay_test_%' ORDER BY nspname",
      )
    ).rows.map((row) => row.nspname);
    assert.deepEqual(schemas, initialTestSchemas);
    await assertNoPublicData(cleanupCheck);
    console.log(
      JSON.stringify({
        stage,
        result: 'PASS',
        publicApplicationRows: 0,
        generatedSchemasRemaining: 0,
      }),
    );
  } finally {
    await cleanupCheck.end();
  }

  command('Phase 2 configuration tests', [
    'run',
    'test',
    '--',
    '--runInBand',
    '--runTestsByPath',
    'src/database/database-connection.config.spec.ts',
    'src/database/postgres-test-guard.spec.ts',
    'src/config/deployment-isolation.spec.ts',
  ]);
  command('backend build', ['run', 'build']);
  command('backend typecheck', [
    'exec',
    '--',
    'tsc',
    '--noEmit',
    '--incremental',
    'false',
  ]);
  command('validator lint', [
    'exec',
    '--',
    'eslint',
    'test/validate-live-supabase.ts',
  ]);
  console.log(
    'Phase 2 remote evidence collection PASS. Acceptance requires review.',
  );
}

void main()
  .catch((error: unknown) => {
    const failure = error as { name?: string; code?: string };
    console.error(
      JSON.stringify({
        stage,
        result: 'FAIL',
        errorClass: failure.name ?? 'Error',
        ...(failure.code && /^[A-Z0-9_]+$/.test(failure.code)
          ? { errorCode: failure.code }
          : {}),
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (certificateDirectory)
      await rm(certificateDirectory, { recursive: true, force: true });
  });
