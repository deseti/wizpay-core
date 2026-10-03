import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { Client } from 'pg';
import { migrationDatabaseUrl } from '../database/database-connection.config';
import {
  applicationTables,
  catalog,
  catalogParity,
  compareSnapshots,
  dataSnapshot,
  migrationContract,
  startSnapshot,
} from './rehearsal-catalog';
import {
  backendRoot,
  connection,
  localHost,
  migrationRoot,
  nativeEnvironment,
  REHEARSAL_MARKER,
  repositoryRoot,
  type RehearsalConfiguration,
  rehearsalConfiguration,
} from './rehearsal-config';

export class RehearsalFailure extends Error {
  constructor(
    readonly stage: string,
    readonly verification?: {
      rows: ReturnType<typeof compareSnapshots>;
      catalog: ReturnType<typeof catalogParity>;
    },
  ) {
    super(
      `Migration rehearsal failed at ${stage}. No connection or row details disclosed.`,
    );
    this.name = 'RehearsalFailure';
  }
}

/** No shell, URL argument or forwarded subprocess output. */
export async function nativeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd: backendRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 4 * 1024 * 1024) output += chunk.toString();
    });
    // Driver/Prisma diagnostics may include a URL or auth material; consume silently.
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Native PostgreSQL command failed.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error('Native PostgreSQL command failed.'));
    });
  });
}

export async function prepareTargetSchema(url: URL, directory: string) {
  // Use existing Phase 2 TLS conversion and the normal Prisma migration engine.
  // A generated non-secret config prevents ambient .env files selecting a target.
  const migrationUrl = migrationDatabaseUrl({
    WIZPAY_ARC_NETWORK: 'arc-mainnet',
    WIZPAY_MIGRATION_NETWORK: 'arc-mainnet',
    WIZPAY_DATABASE_PROFILE: localHost(url.hostname)
      ? 'vps'
      : 'supavisor-transaction',
    WIZPAY_MIGRATION_DATABASE_MODE: url.hostname.endsWith(
      '.pooler.supabase.com',
    )
      ? 'session'
      : 'direct',
    ARC_MAINNET_MIGRATION_DATABASE_URL: url.toString(),
  });
  const config = join(directory, 'prisma.config.ts');
  await writeFile(
    config,
    `const { defineConfig } = require(${JSON.stringify(require.resolve('prisma/config'))});\nexport default defineConfig({schema:${JSON.stringify(join(backendRoot, 'src/database/schema.prisma'))},migrations:{path:${JSON.stringify(migrationRoot)}},datasource:{url:process.env.ARC_MAINNET_MIGRATION_DATABASE_URL}});\n`,
    { mode: 0o600 },
  );
  await nativeCommand(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      config,
    ],
    {
      ...process.env,
      DATABASE_URL: undefined,
      DIRECT_URL: undefined,
      ARC_MAINNET_MIGRATION_DATABASE_URL: migrationUrl,
    },
  );
}

export async function assertReadOnlySource(client: Client, tables: string[]) {
  const role = (
    await client.query<{
      elevated: boolean;
    }>(`SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated
    FROM pg_roles WHERE rolname=current_user`)
  ).rows[0];
  assert(!role.elevated);
  const privileges = (
    await client.query<{ name: string; writable: boolean; readable: boolean }>(
      `SELECT c.relname AS name,
    (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      OR has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      OR has_schema_privilege('public','CREATE')) AS writable,
    has_table_privilege(c.oid,'SELECT') AS readable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1)`,
      [tables],
    )
  ).rows;
  assert.equal(privileges.length, tables.length);
  assert(privileges.every((row) => row.readable && !row.writable));
  assert.equal(
    (
      await client.query<{ transaction_read_only: string }>(
        'SHOW transaction_read_only',
      )
    ).rows[0].transaction_read_only,
    'on',
  );
}

async function identity(client: Client) {
  return (
    await client.query<{ database: string; oid: string; started: string }>(
      `SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      extract(epoch FROM pg_postmaster_start_time())::text AS started`,
    )
  ).rows[0];
}

export async function assertTargetIdentity(
  client: Client,
  config: RehearsalConfiguration,
) {
  assert.equal(
    (await identity(client)).database,
    decodeURIComponent(config.target.pathname.slice(1)),
  );
  if (config.localTarget) {
    const marker = (
      await client.query<{ marker: string | null }>(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0].marker;
    assert.equal(marker, REHEARSAL_MARKER);
  }
}

export async function assertCleanTarget(client: Client) {
  const objects = (
    await client.query<{
      count: string;
    }>(`SELECT count(*)::text AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relkind IN ('r','p','v','m','f','S')`)
  ).rows[0];
  assert.equal(objects.count, '0');
  // Provider-owned extensions in public are allowed; user enum types are not.
  assert.equal(
    (
      await client.query<{
        count: string;
      }>(`SELECT count(*)::text AS count FROM pg_type t
    JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'`)
    ).rows[0].count,
    '0',
  );
}

async function assertMigrationHistory(client: Client) {
  const { migrations } = await migrationContract();
  const applied = (
    await client.query<{
      migration_name: string;
      checksum: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations',
    )
  ).rows;
  assert.equal(applied.length, migrations.length);
  for (const migration of migrations)
    assert(
      applied.some(
        (row) =>
          row.migration_name === migration.name &&
          row.checksum === migration.checksum &&
          row.finished_at &&
          !row.rolled_back_at,
      ),
    );
}

export async function resetLocalTarget(
  client: Client,
  config: RehearsalConfiguration,
  expectedTables: string[],
) {
  assert(config.localTarget, 'Remote target reset is never permitted.');
  await assertTargetIdentity(client, config);
  assert(
    (await applicationTables(client)).every((table) =>
      expectedTables.includes(table),
    ),
  );
  await client.query('BEGIN');
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
    throw new Error('Local rehearsal target reset failed.');
  }
}

async function archiveDirectory(config: RehearsalConfiguration) {
  const parent = config.backupDirectory ?? tmpdir();
  assert(isAbsolute(parent));
  await mkdir(parent, { recursive: true });
  const actual = await realpath(parent);
  const inside = relative(repositoryRoot, actual);
  assert(
    inside.startsWith('../') || isAbsolute(inside),
    'Backup directory must be outside the checkout.',
  );
  return mkdtemp(join(actual, 'wizpay-migration-rehearsal-'));
}

export async function runMigrationRehearsal(
  config: RehearsalConfiguration,
  options: { reset?: boolean; verifyOnly?: boolean } = {},
) {
  let stage = 'preflight';
  const source = new Client(connection(config.source, true));
  const target = new Client(connection(config.target));
  let directory: string | undefined;
  let succeeded = false;
  let verification: RehearsalFailure['verification'];
  const postgresVersions = { source: 0, target: 0 };
  try {
    assert(!(options.reset && options.verifyOnly));
    await source.connect();
    await target.connect();
    assert.notDeepEqual(await identity(source), await identity(target));
    await assertTargetIdentity(target, config);
    const contract = await migrationContract();
    await startSnapshot(source);
    await assertReadOnlySource(source, contract.tables);
    assert.deepEqual(await applicationTables(source), contract.tables);
    for (const client of [source, target]) {
      const version = Number(
        (
          await client.query<{ server_version_num: string }>(
            'SHOW server_version_num',
          )
        ).rows[0].server_version_num,
      );
      assert(
        version >= (client === source ? 150000 : 170000) && version < 180000,
      );
      postgresVersions[client === source ? 'source' : 'target'] = version;
    }
    stage = 'source snapshot';
    const sourceCatalog = await catalog(source, contract.tables);
    const sourceData = await dataSnapshot(source, contract.tables);
    assert.equal(
      (
        await source.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public."ExecutionIntent" WHERE network <> 'arc-mainnet'`,
        )
      ).rows[0].count,
      '0',
    );
    const snapshot = (
      await source.query<{ snapshot: string }>(
        'SELECT pg_export_snapshot() AS snapshot',
      )
    ).rows[0].snapshot;
    if (!options.verifyOnly) {
      stage = 'target safety';
      if (options.reset)
        await resetLocalTarget(target, config, contract.tables);
      await assertCleanTarget(target);
      directory = await archiveDirectory(config);
      for (const tool of ['pg_dump', 'pg_restore'] as const)
        assert(
          /\(PostgreSQL\) 17\./.test(
            await nativeCommand(
              config.binary(tool),
              ['--version'],
              nativeEnvironment(config.source, true),
            ),
          ),
        );
      stage = 'consistent export';
      const archive = join(directory, 'application.dump');
      await nativeCommand(
        config.binary('pg_dump'),
        [
          '--format=custom',
          '--data-only',
          '--schema=public',
          '--exclude-table=public._prisma_migrations',
          '--no-owner',
          '--no-privileges',
          '--lock-wait-timeout=5s',
          `--snapshot=${snapshot}`,
          `--file=${archive}`,
        ],
        nativeEnvironment(config.source, true),
      );
      await chmod(archive, 0o600);
      const list = await nativeCommand(
        config.binary('pg_restore'),
        ['--list', archive],
        nativeEnvironment(config.target, false),
      );
      const exported = [...list.matchAll(/TABLE DATA public ([a-zA-Z]+) /g)]
        .map((match) => match[1])
        .sort();
      assert.deepEqual(exported, contract.tables);
      stage = 'target migrations';
      await prepareTargetSchema(config.target, directory);
      assert.deepEqual(await applicationTables(target), contract.tables);
      assert(
        Object.values(
          catalogParity(sourceCatalog, await catalog(target, contract.tables)),
        ).every(Boolean),
      );
      await assertMigrationHistory(target);
      stage = 'atomic restore';
      await nativeCommand(
        config.binary('pg_restore'),
        [
          '--data-only',
          '--single-transaction',
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          '--dbname',
          decodeURIComponent(config.target.pathname.slice(1)),
          archive,
        ],
        nativeEnvironment(config.target, false),
      );
    }
    stage = 'target verification';
    await startSnapshot(target);
    assert.deepEqual(await applicationTables(target), contract.tables);
    await assertMigrationHistory(target);
    const targetCatalog = await catalog(target, contract.tables);
    const parity = catalogParity(sourceCatalog, targetCatalog);
    const rows = compareSnapshots(
      sourceData,
      await dataSnapshot(target, contract.tables),
    );
    verification = { rows, catalog: parity };
    assert(Object.values(parity).every(Boolean));
    assert(rows.every((row) => row.match && row.integrity_match));
    assert.deepEqual(await dataSnapshot(source, contract.tables), sourceData);
    const constraintCount = (type: string) =>
      sourceCatalog.constraints.filter((row) => row.type === type).length;
    let backup:
      | { file: string; bytes: number; sha256: string; retained: boolean }
      | undefined;
    if (directory) {
      const archive = join(directory, 'application.dump');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(archive))
        hash.update(chunk as Buffer);
      backup = {
        file: basename(archive),
        bytes: (await stat(archive)).size,
        sha256: hash.digest('hex'),
        retained: Boolean(config.backupDirectory),
      };
    }
    await target.query('COMMIT');
    await source.query('COMMIT');
    succeeded = true;
    return {
      version: 1,
      scope:
        config.localTarget && localHost(config.source.hostname)
          ? 'ISOLATED'
          : 'EXPLICIT_HOSTED_REHEARSAL',
      result: 'PASS',
      postgresVersions,
      schemaContract: contract.migrations.map(({ name, checksum }) => ({
        name,
        checksum,
      })),
      sourceTables: contract.tables.length,
      targetTables: contract.tables.length,
      rows,
      catalog: {
        parity,
        primaryKeys: constraintCount('p'),
        uniqueConstraints: constraintCount('u'),
        foreignKeys: constraintCount('f'),
        checks: constraintCount('c'),
        indexes: sourceCatalog.indexes.length,
        uniqueIndexes: sourceCatalog.indexes.filter((row) => row.unique).length,
        enums: new Set(sourceCatalog.enums.map((row) => row.name)).size,
      },
      integrity: 'ALL_APPLICATION_COLUMNS_EXACT',
      sourceReadOnly: true,
      sourceWritesPerformed: false,
      backup,
      deferred: config.localTarget
        ? [
            'production-read-only-export',
            'hosted-supabase-import',
            'hosted-catalog-and-data-verification',
          ]
        : [],
    };
  } catch {
    throw new RehearsalFailure(stage, verification);
  } finally {
    await source.query('ROLLBACK').catch(() => undefined);
    await target.query('ROLLBACK').catch(() => undefined);
    await source.end().catch(() => undefined);
    await target.end().catch(() => undefined);
    if (directory) {
      // Retain a successful archive only under the explicitly requested outside-checkout directory.
      if (!succeeded || !config.backupDirectory)
        await rm(directory, { recursive: true, force: true });
      else await rm(join(directory, 'prisma.config.ts'), { force: true });
    }
  }
}

if (require.main === module) {
  void (async () => {
    const allowed = ['--reset-target', '--verify-only'];
    assert(process.argv.slice(2).every((arg) => allowed.includes(arg)));
    const result = await runMigrationRehearsal(
      rehearsalConfiguration(process.env),
      {
        reset: process.argv.includes('--reset-target'),
        verifyOnly: process.argv.includes('--verify-only'),
      },
    );
    console.log(JSON.stringify(result, null, 2));
  })().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        result: 'FAIL',
        stage:
          error instanceof RehearsalFailure ? error.stage : 'configuration',
        details: 'Connection and row diagnostics redacted.',
        verification:
          error instanceof RehearsalFailure ? error.verification : undefined,
      }),
    );
    process.exitCode = 1;
  });
}
