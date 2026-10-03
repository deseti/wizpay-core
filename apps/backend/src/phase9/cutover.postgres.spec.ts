import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { openPostgresHarness } from '../../test/postgres-harness';
import { buildVercelOutput } from '../deployment/vercel-build';
import { fixtureId, seedRehearsalFixtures } from '../phase7/rehearsal-fixtures';
import {
  applicationTables,
  dataSnapshot,
  compareSnapshots,
  startSnapshot,
} from '../phase7/rehearsal-catalog';
import {
  advance,
  STAGES,
  startCutover,
  rollback,
  noteTargetWrites,
} from './cutover';
import { candidate, evidence, fixtureRelease } from './fixtures';

const describeLocal = process.env.VERCEL_API_TEST_DATABASE_URL
  ? describe
  : describe.skip;
describeLocal(
  'Phase 9 isolated database + packaged function cutover simulation',
  () => {
    it('walks gates, reads preserved durable state through local artifact, and fences rollback after writes', async () => {
      const harness = await openPostgresHarness(
        'VERCEL_API_TEST_DATABASE_URL',
        'wizpay_phase6_test_admin',
      );
      const sandbox = await mkdtemp(join(tmpdir(), 'wizpay-phase9-artifact-'));
      let database: Client | undefined;
      try {
        await seedRehearsalFixtures(harness.prisma);
        // Native migration fixtures use arbitrary public IDs; HTTP requires exactly 22 characters.
        await harness.prisma.invoice.update({
          where: { id: fixtureId(71) },
          data: { publicId: 'p9' + 'a'.repeat(20) },
        });
        const identity = await harness.prisma.$queryRaw<
          { name: string }[]
        >`SELECT current_database() AS name`;
        const url = new URL(process.env.VERCEL_API_TEST_DATABASE_URL!);
        url.pathname = '/' + identity[0].name;
        database = new Client({ connectionString: url.toString() });
        await database.connect();
        const tables = await applicationTables(database);
        await database.query(
          await readFile(
            join(
              __dirname,
              '../../../../deploy/serverless-cutover/observation.sql',
            ),
            'utf8',
          ),
        );
        await startSnapshot(database);
        const before = await dataSnapshot(database, tables);
        await database.query('COMMIT');
        expect(tables).toHaveLength(15);
        const built = await buildVercelOutput();
        expect(built.files.some((file) => /bullmq|ioredis/.test(file))).toBe(
          false,
        );
        await cp(built.functionRoot, sandbox, { recursive: true });
        const driver = await readFile(
          join(__dirname, '../../test/phase9-artifact.cjs'),
          'utf8',
        );
        const child = spawn(process.execPath, ['-'], {
          cwd: sandbox,
          env: {
            PATH: process.env.PATH,
            NODE_PATH: '',
            NODE_ENV: 'production',
            WIZPAY_RUNTIME_MODE: 'serverless',
            WIZPAY_ARC_NETWORK: 'arc-mainnet',
            WIZPAY_DATABASE_PROFILE: 'vps',
            ARC_MAINNET_DATABASE_URL: url.toString(),
            CORS_ORIGINS: 'https://app.wizpay.xyz',
            WIZPAY_ARC_MAINNET_CAPABILITY_INVOICE: 'true',
            WIZPAY_ARC_MAINNET_CAPABILITY_PAYMENT_LINK: 'true',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let safeOutput = '';
        child.stdout.on('data', (value: Buffer) => {
          safeOutput += value.toString();
        });
        // Raw stderr may contain private driver data: consume without publishing.
        let failureStage = 'unknown';
        child.stderr.on('data', (value: Buffer) => {
          const match = value
            .toString()
            .match(/PHASE9_LOCAL_ARTIFACT_FAIL:([a-z-]+)/);
          if (match) failureStage = match[1];
        });
        child.stdin.end(driver);
        const timeout = setTimeout(() => child.kill('SIGKILL'), 40_000);
        try {
          const exit = await new Promise<number | null>((resolve, reject) => {
            child.on('close', resolve);
            child.on('error', reject);
          });
          if (exit !== 0)
            throw new Error('Local artifact failed at ' + failureStage);
          expect(safeOutput).toContain('PHASE9_LOCAL_ARTIFACT_PASS');
        } finally {
          clearTimeout(timeout);
        }
        await startSnapshot(database);
        const rows = compareSnapshots(
          before,
          await dataSnapshot(database, tables),
        );
        await database.query('COMMIT');
        expect(rows.every((row) => row.match && row.integrity_match)).toBe(
          true,
        );
        // Real local DB/artifact facts plus synthetic provider/deployment/switch facts.
        // Scope cannot be promoted to LIVE; no production endpoints are contacted.
        let state = startCutover(fixtureRelease(), candidate, 'OFFLINE');
        for (const stage of STAGES) {
          if (stage === 'DATABASE_VERIFY')
            expect(rows.every((row) => row.integrity_match)).toBe(true);
          if (stage === 'FRONTEND_SWITCH') {
            expect(() =>
              advance(
                { ...state, stages: ['PRECHECK'] },
                stage,
                evidence(stage),
              ),
            ).toThrow('GATE_ORDER');
          }
          state = advance(state, stage, evidence(stage));
          if (stage === 'PRODUCTION_SMOKE') {
            expect(
              rollback(noteTargetWrites(state, 'PRESENT'), true).decision,
            ).toBe('RECONCILIATION_REQUIRED');
          }
        }
        expect(state.decision).toBe('ACCEPTED');
        expect(state.scope).toBe('OFFLINE');
        expect(
          Object.values(before).reduce(
            (total, row) => total + Number(row.count),
            0,
          ),
        ).toBe(45);
      } finally {
        if (database) await database.end();
        await harness.close();
        await rm(sandbox, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
