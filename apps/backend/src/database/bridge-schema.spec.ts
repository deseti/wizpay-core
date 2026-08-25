import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('bridge persistence migration', () => {
  it('creates the BridgeTransaction table required by the bridge intent service', () => {
    const migration = readFileSync(
      join(
        __dirname,
        'migrations/20260824090000_bridge_transactions/migration.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE "BridgeTransaction"');
    expect(migration).toContain('"taskId" UUID NOT NULL');
    expect(migration).toContain('"payload" JSONB NOT NULL');
    expect(migration).toContain('"BridgeTransaction_taskId_key"');
    expect(migration).toContain('REFERENCES "Task"("id")');
  });
});
