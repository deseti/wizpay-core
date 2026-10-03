import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot } from '../phase7/rehearsal-config';
describe('Phase 10 recovery inventory and completion records', () => {
  it('links each classified dependency to existing scoped repository evidence', async () => {
    const inventory = JSON.parse(
      await readFile(
        join(
          repositoryRoot,
          'deploy/serverless-decommission/dependency-inventory.json',
        ),
        'utf8',
      ),
    ) as {
      dependencies: { id: string; classification: string; sources: string[] }[];
      current_host_sharing: string;
    };
    expect(inventory.dependencies.length).toBeGreaterThanOrEqual(18);
    expect(inventory.current_host_sharing).toBe('UNKNOWN');
    for (const dependency of inventory.dependencies) {
      expect([
        'REMOVED',
        'REPLACED',
        'MUST_VERIFY_LIVE',
        'HISTORICAL_ONLY',
        'BLOCKS_DECOMMISSION',
      ]).toContain(dependency.classification);
      for (const source of dependency.sources)
        await expect(
          access(join(repositoryRoot, source)),
        ).resolves.toBeUndefined();
    }
  });
  it('stores names/management locations only and forbids private-key recovery', async () => {
    const raw = await readFile(
      join(
        repositoryRoot,
        'deploy/serverless-decommission/environment-recovery.json',
      ),
      'utf8',
    );
    const inventory = JSON.parse(raw) as {
      variables: {
        name: string;
        classification: string;
        managed_in: string;
        previous_consumer: string;
        required_by_serverless: boolean;
      }[];
    };
    expect(inventory.variables.length).toBeGreaterThan(30);
    for (const variable of inventory.variables) {
      expect(variable.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect([
        'ACTIVE_SERVERLESS',
        'HISTORICAL_VPS',
        'RETIRED',
        'MANUAL_VERIFY',
      ]).toContain(variable.classification);
      expect(Object.keys(variable).sort()).toEqual([
        'classification',
        'managed_in',
        'name',
        'previous_consumer',
        'required_by_serverless',
      ]);
    }
    expect(
      inventory.variables.find((row) => row.name === 'PRIVATE_KEY'),
    ).toMatchObject({
      classification: 'RETIRED',
      required_by_serverless: false,
    });
    expect(raw).not.toMatch(
      /postgresql:\/\/|BEGIN PRIVATE KEY|Bearer [a-zA-Z0-9_-]+/,
    );
  });
  it('preserves historical Phase 1 acceptance and records live cutover/decommission as deferred', async () => {
    const log = await readFile(
      join(repositoryRoot, 'docs/serverless-migration-log.md'),
      'utf8',
    );
    expect(log).toContain(
      'Status: ACCEPTED\nBranch: feat/serverless-free-stack\nCommit: 5bd227f',
    );
    expect(log).toContain('Live production acceptance: DEFERRED');
    expect(log).toContain('Actual decommission: DEFERRED');
    expect(log).not.toMatch(/Phase 10[^]*Status: ACCEPTED/);
  });
});
