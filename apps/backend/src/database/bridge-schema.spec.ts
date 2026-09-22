import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('bridge persistence in the Arc Mainnet baseline', () => {
  it('creates the current BridgeTransaction table required by the bridge intent service', () => {
    const migration = readFileSync(
      join(
        __dirname,
        'migrations/20260922210000_arc_mainnet_fresh_baseline/migration.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE "BridgeTransaction"');
    expect(migration).toContain('"taskId" TEXT NOT NULL');
    expect(migration).toContain('"payload" JSONB NOT NULL');
    expect(migration).toContain('"BridgeTransaction_taskId_key"');
  });
});
