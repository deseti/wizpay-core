import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  catalog,
  dataSnapshot,
  migrationContract,
  startSnapshot,
} from './rehearsal-catalog';
import {
  connection,
  REHEARSAL_ACK,
  REHEARSAL_MARKER,
  rehearsalConfiguration,
} from './rehearsal-config';
import {
  prepareTargetSchema,
  RehearsalFailure,
  resetLocalTarget,
  runMigrationRehearsal,
} from './migration-rehearsal';
import { fixtureId, seedRehearsalFixtures } from './rehearsal-fixtures';

const describeLocal = process.env.PHASE7_MIGRATION_TEST_DATABASE_URL
  ? describe
  : describe.skip;

describeLocal(
  'Phase 7 actual native PostgreSQL source-to-target rehearsal',
  () => {
    let admin: Client;
    let sourceManager: Client;
    let sourceAdmin: Client;
    let target: Client;
    let directory: string;
    let sourceUrl: URL;
    let sourcePrivilegedUrl: URL;
    let targetUrl: URL;
    let reader: string;
    let sourceDatabase: string;
    let targetDatabase: string;
    let baseline: Awaited<ReturnType<typeof dataSnapshot>>;
    let initialCatalog: Awaited<ReturnType<typeof catalog>>;
    let tables: string[];
    let first: Awaited<ReturnType<typeof runMigrationRehearsal>>;
    let second: Awaited<ReturnType<typeof runMigrationRehearsal>>;

    const config = () =>
      rehearsalConfiguration({
        WIZPAY_MIGRATION_SOURCE_URL: sourceUrl.toString(),
        WIZPAY_MIGRATION_TARGET_URL: targetUrl.toString(),
        WIZPAY_MIGRATION_REHEARSAL_ACK: REHEARSAL_ACK,
        WIZPAY_MIGRATION_TARGET_HOST: targetUrl.hostname,
        WIZPAY_MIGRATION_TARGET_DATABASE: targetDatabase,
        WIZPAY_REHEARSAL_PG_BIN: process.env.WIZPAY_REHEARSAL_PG_BIN,
      });
    const currentSource = async () => {
      const client = new Client(connection(sourceUrl, true));
      await client.connect();
      try {
        await startSnapshot(client);
        return {
          data: await dataSnapshot(client, tables),
          catalog: await catalog(client, tables),
        };
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    };

    beforeAll(async () => {
      const local = new URL(process.env.PHASE7_MIGRATION_TEST_DATABASE_URL!);
      assert(['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname));
      assert.equal(local.pathname, '/wizpay_phase7_test_admin');
      const sourceLocal = new URL(
        process.env.PHASE7_MIGRATION_SOURCE_TEST_DATABASE_URL ??
          local.toString(),
      );
      assert(
        ['127.0.0.1', 'localhost', '[::1]'].includes(sourceLocal.hostname),
      );
      assert.equal(sourceLocal.pathname, '/wizpay_phase7_test_admin');
      directory = await mkdtemp(join(tmpdir(), 'wizpay-phase7-fixture-'));
      const suffix = randomUUID().replaceAll('-', '');
      sourceDatabase = `wizpay_phase7_source_${suffix}`;
      targetDatabase = `wizpay_rehearsal_${suffix}`;
      reader = `wizpay_phase7_reader_${suffix}`;
      const password = randomBytes(24).toString('hex');
      admin = new Client({ connectionString: local.toString() });
      await admin.connect();
      sourceManager = new Client({ connectionString: sourceLocal.toString() });
      await sourceManager.connect();
      await sourceManager.query(`CREATE DATABASE "${sourceDatabase}"`);
      await admin.query(`CREATE DATABASE "${targetDatabase}"`);
      await admin.query(
        `COMMENT ON DATABASE "${targetDatabase}" IS '${REHEARSAL_MARKER}'`,
      );
      await sourceManager.query(
        `CREATE ROLE "${reader}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
      const sourceAdminUrl = new URL(sourceLocal);
      sourceAdminUrl.pathname = `/${sourceDatabase}`;
      sourcePrivilegedUrl = sourceAdminUrl;
      targetUrl = new URL(local);
      targetUrl.pathname = `/${targetDatabase}`;
      await prepareTargetSchema(sourceAdminUrl, directory);
      const prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: sourceAdminUrl.toString() }),
      });
      try {
        await seedRehearsalFixtures(prisma);
      } finally {
        await prisma.$disconnect();
      }
      sourceAdmin = new Client({ connectionString: sourceAdminUrl.toString() });
      await sourceAdmin.connect();
      await sourceAdmin.query(`GRANT USAGE ON SCHEMA public TO "${reader}"`);
      await sourceAdmin.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${reader}"`,
      );
      sourceUrl = new URL(sourceAdminUrl);
      sourceUrl.username = reader;
      sourceUrl.password = password;
      target = new Client({ connectionString: targetUrl.toString() });
      await target.connect();
      tables = (await migrationContract()).tables;
      const current = await currentSource();
      baseline = current.data;
      initialCatalog = current.catalog;
      first = await runMigrationRehearsal(config());
      second = await runMigrationRehearsal(config(), { reset: true });
    }, 120_000);

    afterAll(async () => {
      await sourceAdmin?.end();
      await target?.end();
      if (admin) {
        if (sourceDatabase && sourceManager)
          await sourceManager.query(
            `DROP DATABASE IF EXISTS "${sourceDatabase}" WITH (FORCE)`,
          );
        if (targetDatabase)
          await admin.query(
            `DROP DATABASE IF EXISTS "${targetDatabase}" WITH (FORCE)`,
          );
        if (reader && sourceManager)
          await sourceManager.query(`DROP ROLE IF EXISTS "${reader}"`);
        await sourceManager?.end();
        await admin.end();
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('imports all application tables and preserves every full row, PK/FK/index/enum/check', () => {
      expect(first.result).toBe('PASS');
      expect(first.scope).toBe('ISOLATED');
      expect(first.sourceTables).toBe(15);
      expect(first.targetTables).toBe(15);
      expect(
        first.rows.every(
          (row) =>
            row.match && row.integrity_match && Number(row.source_count) > 0,
        ),
      ).toBe(true);
      expect(Object.values(first.catalog.parity).every(Boolean)).toBe(true);
      expect(first.catalog).toMatchObject({
        primaryKeys: 15,
        foreignKeys: 4,
        checks: 4,
        enums: 6,
      });
      expect(first.backup?.bytes).toBeGreaterThan(0);
      expect(first.backup?.retained).toBe(false);
    });
    it('safely resets the marked target, repeats native export/import and revalidates immediately', async () => {
      expect(second.rows).toEqual(first.rows);
      expect(second.catalog).toEqual(first.catalog);
      const repeated = await runMigrationRehearsal(config(), {
        verifyOnly: true,
      });
      expect(repeated.rows).toEqual(first.rows);
      const evidence = {
        first,
        second,
        revalidation: repeated.result,
        sourceUnchanged: true,
      };
      expect(await currentSource()).toEqual({
        data: baseline,
        catalog: initialCatalog,
      });
      const output = process.env.WIZPAY_PHASE7_EVIDENCE_FILE;
      if (output)
        await writeFile(output, JSON.stringify(evidence, null, 2), {
          mode: 0o600,
        });
    }, 60_000);
    it('preserves the source in a fresh snapshot and denies both SQL writes and privileged source use', async () => {
      expect(await currentSource()).toEqual({
        data: baseline,
        catalog: initialCatalog,
      });
      const readonly = new Client(connection(sourceUrl, true));
      await readonly.connect();
      try {
        await expect(
          readonly.query(
            'UPDATE public."ExecutionIntent" SET status=\'CREATED\'',
          ),
        ).rejects.toMatchObject({ code: '25006' });
      } finally {
        await readonly.end();
      }
      const noWrites = new Client(connection(sourceUrl));
      await noWrites.connect();
      try {
        await expect(
          noWrites.query('DELETE FROM public."ExecutionIntent"'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await noWrites.end();
      }
      const privileged = sourcePrivilegedUrl;
      await expect(
        runMigrationRehearsal(
          { ...config(), source: privileged },
          { verifyOnly: true },
        ),
      ).rejects.toMatchObject({ stage: 'preflight' });
    });
    it('refuses a nonempty target without reset and fails closed on a missing target marker', async () => {
      await expect(
        runMigrationRehearsal(
          { ...config(), target: sourceUrl },
          { verifyOnly: true },
        ),
      ).rejects.toMatchObject({ stage: 'preflight' });
      await expect(runMigrationRehearsal(config())).rejects.toMatchObject({
        stage: 'target safety',
      });
      await admin.query(`COMMENT ON DATABASE "${targetDatabase}" IS NULL`);
      try {
        await expect(
          runMigrationRehearsal(config(), { reset: true }),
        ).rejects.toMatchObject({ stage: 'preflight' });
      } finally {
        await admin.query(
          `COMMENT ON DATABASE "${targetDatabase}" IS '${REHEARSAL_MARKER}'`,
        );
      }
    });
    it('rejects arbitrary remote reset even if passed a connected local client', async () => {
      await expect(
        resetLocalTarget(target, { ...config(), localTarget: false }, tables),
      ).rejects.toThrow('Remote target reset');
    });
    it('detects corruption of financial identity with unchanged row counts and does not disclose values', async () => {
      await target.query(
        'UPDATE public."ExecutionIntent" SET "sourceWallet"=$1 WHERE id=$2',
        ['0x9999999999999999999999999999999999999999', fixtureId(36)],
      );
      try {
        await expect(
          runMigrationRehearsal(config(), { verifyOnly: true }),
        ).rejects.toMatchObject({ stage: 'target verification' });
      } finally {
        await target.query(
          'UPDATE public."ExecutionIntent" SET "sourceWallet"=$1 WHERE id=$2',
          ['0x0000000000000000000000000000000000000001', fixtureId(36)],
        );
      }
    });
    it('rejects missing replay-protection indexes and restores parity after repair', async () => {
      const index = 'ExecutionIntent_logicalKey_key';
      await target.query(`DROP INDEX public."${index}"`);
      try {
        await expect(
          runMigrationRehearsal(config(), { verifyOnly: true }),
        ).rejects.toMatchObject({ stage: 'target verification' });
      } finally {
        await target.query(
          `CREATE UNIQUE INDEX "${index}" ON public."ExecutionIntent"("logicalKey")`,
        );
      }
      expect(
        (await runMigrationRehearsal(config(), { verifyOnly: true })).result,
      ).toBe('PASS');
    });
    it('fails on a real table count mismatch and provides safe structural diagnostics', async () => {
      const removed = (
        await target.query<{ value: string }>(
          'DELETE FROM public."TaskLog" t WHERE id=$1 RETURNING to_jsonb(t)::text AS value',
          [fixtureId(13)],
        )
      ).rows[0].value;
      try {
        const failure: unknown = await runMigrationRehearsal(config(), {
          verifyOnly: true,
        }).catch((error: unknown) => error);
        assert(failure instanceof RehearsalFailure);
        expect(failure.stage).toBe('target verification');
        expect(
          failure.verification?.rows.find((row) => row.table === 'TaskLog'),
        ).toMatchObject({
          table: 'TaskLog',
          source_count: '2',
          target_count: '1',
          match: false,
        });
      } finally {
        await target.query(
          'INSERT INTO public."TaskLog" SELECT * FROM jsonb_populate_record(NULL::public."TaskLog",$1::jsonb)',
          [removed],
        );
      }
    });
    it('reports only structural/count evidence, never row content, session hashes or URLs', async () => {
      const json = JSON.stringify(first);
      for (const value of [
        'synthetic-hash-',
        'synthetic-nonce-',
        'phase7-fake-owner',
        sourceUrl.password,
        'postgresql://',
        'fake@example.invalid',
      ])
        expect(json).not.toContain(value);
      expect(
        await readFile(join(directory, 'prisma.config.ts'), 'utf8'),
      ).not.toContain(sourceUrl.password);
      expect(first.deferred).toContain('hosted-supabase-import');
    });
  },
);
