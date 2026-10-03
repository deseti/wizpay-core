import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openPostgresHarness } from '../../test/postgres-harness';
import { seedRehearsalFixtures } from '../phase7/rehearsal-fixtures';
import {
  applicationTables,
  dataSnapshot,
  compareSnapshots,
  startSnapshot,
} from '../phase7/rehearsal-catalog';
import { repositoryRoot } from '../phase7/rehearsal-config';
const describeLocal = process.env.VERCEL_API_TEST_DATABASE_URL
  ? describe
  : describe.skip;
describeLocal('Phase 10 read-only reconciliation readiness SQL', () => {
  it('reports durable work/leases without changing financial, auth or retry state', async () => {
    const harness = await openPostgresHarness(
      'VERCEL_API_TEST_DATABASE_URL',
      'wizpay_phase6_test_admin',
    );
    let client: Client | undefined;
    try {
      await seedRehearsalFixtures(harness.prisma);
      const db = await harness.prisma.$queryRaw<
        { name: string }[]
      >`SELECT current_database() AS name`;
      const url = new URL(process.env.VERCEL_API_TEST_DATABASE_URL!);
      url.pathname = '/' + db[0].name;
      client = new Client({ connectionString: url.toString() });
      await client.connect();
      const tables = await applicationTables(client);
      await startSnapshot(client);
      const before = await dataSnapshot(client, tables);
      await client.query('COMMIT');
      await client.query(
        await readFile(
          join(
            repositoryRoot,
            'deploy/serverless-decommission/reconciliation.sql',
          ),
          'utf8',
        ),
      );
      await startSnapshot(client);
      const after = await dataSnapshot(client, tables);
      await client.query('COMMIT');
      expect(
        compareSnapshots(before, after).every(
          (row) => row.match && row.integrity_match,
        ),
      ).toBe(true);
      expect(tables).toHaveLength(15);
      expect(await harness.prisma.reconciliationWork.count()).toBe(4);
    } finally {
      if (client) await client.end();
      await harness.close();
    }
  }, 30_000);
});
