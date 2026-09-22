import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationsRoot = join(__dirname, 'migrations');
const baselineName = '20260922210000_arc_mainnet_fresh_baseline';
const baseline = readFileSync(
  join(migrationsRoot, baselineName, 'migration.sql'),
  'utf8',
);

describe('fresh Arc Mainnet Prisma baseline', () => {
  it('is the only deployable migration and contains SQL only', () => {
    const migrationDirectories = readdirSync(migrationsRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(migrationDirectories).toEqual([baselineName]);
    expect(baseline.startsWith('-- CreateSchema\n')).toBe(true);
    expect(baseline).not.toMatch(/Loaded Prisma|injected env|◇/i);
  });

  it('creates exactly the current application tables', () => {
    const tables = [...baseline.matchAll(/CREATE TABLE "([^"]+)"/g)].map(
      ([, name]) => name,
    );
    expect(tables).toEqual([
      'Task',
      'TaskLog',
      'TaskUnit',
      'TaskTransaction',
      'UserWallet',
      'Invoice',
      'InvoicePayment',
      'ExecutionIntent',
      'BridgeTransaction',
      'Activity',
      'ActivityAuthSession',
      'WalletAuthChallenge',
      'VerifiedSwapTransaction',
      'ActivitySyncState',
    ]);
  });

  it('preserves all current enums, indexes, uniqueness, and foreign keys', () => {
    for (const enumName of [
      'InvoiceStatus',
      'InvoicePaymentStatus',
      'InvoiceSettlementKind',
      'ExecutionIntentOperation',
      'ExecutionIntentRoute',
      'ExecutionIntentStatus',
    ]) {
      expect(baseline).toContain(`CREATE TYPE "${enumName}" AS ENUM`);
    }
    expect(baseline.match(/CREATE (?:UNIQUE )?INDEX/g)).toHaveLength(49);
    expect(baseline.match(/ADD CONSTRAINT .* FOREIGN KEY/g)).toHaveLength(4);
  });

  it('contains no removed wallet, provider, network, or treasury objects', () => {
    expect(baseline).not.toMatch(
      /AppWallet|Xylo|StableFX|Testnet|5042002|Sepolia|W3S|developer-controlled|treasury/i,
    );
    expect(baseline).not.toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|CREATE\s+TRIGGER/i,
    );
  });
});
