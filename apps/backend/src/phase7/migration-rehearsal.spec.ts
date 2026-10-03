import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogParity, compareSnapshots } from './rehearsal-catalog';
import {
  backendRoot,
  nativeEnvironment,
  REHEARSAL_ACK,
  rehearsalConfiguration,
} from './rehearsal-config';

const target = 'wizpay_rehearsal_0123456789abcdef0123456789abcdef';
export function testConfiguration() {
  return {
    WIZPAY_MIGRATION_REHEARSAL_ACK: REHEARSAL_ACK,
    WIZPAY_MIGRATION_SOURCE_URL:
      'postgresql://reader:fake@localhost:15437/source',
    WIZPAY_MIGRATION_TARGET_URL: `postgresql://postgres:fake@127.0.0.1:15437/${target}`,
    WIZPAY_MIGRATION_TARGET_HOST: '127.0.0.1',
    WIZPAY_MIGRATION_TARGET_DATABASE: target,
  };
}

describe('migration rehearsal safety and comparisons', () => {
  it('rejects identical databases even with loopback aliases', () => {
    expect(() =>
      rehearsalConfiguration({
        ...testConfiguration(),
        WIZPAY_MIGRATION_SOURCE_URL: `postgresql://reader:fake@localhost:15437/${target}`,
      }),
    ).toThrow('different databases');
  });
  it('requires acknowledgement and separately identified target', () => {
    for (const key of [
      'WIZPAY_MIGRATION_REHEARSAL_ACK',
      'WIZPAY_MIGRATION_TARGET_HOST',
      'WIZPAY_MIGRATION_TARGET_DATABASE',
    ])
      expect(() =>
        rehearsalConfiguration({ ...testConfiguration(), [key]: undefined }),
      ).toThrow();
  });
  it('rejects production-like local names, generic fallback and ambiguous URL options', () => {
    expect(() =>
      rehearsalConfiguration({
        ...testConfiguration(),
        WIZPAY_MIGRATION_TARGET_URL:
          'postgresql://postgres:fake@127.0.0.1:15437/wizpay_production',
        WIZPAY_MIGRATION_TARGET_DATABASE: 'wizpay_production',
      }),
    ).toThrow('dedicated rehearsal');
    for (const key of ['DATABASE_URL', 'DIRECT_URL'])
      expect(() =>
        rehearsalConfiguration({ ...testConfiguration(), [key]: 'fake' }),
      ).toThrow('Unscoped');
    for (const options of [
      '?sslmode=disable&sslmode=verify-full',
      '?options=anything',
      '?schema=other',
    ])
      expect(() =>
        rehearsalConfiguration({
          ...testConfiguration(),
          WIZPAY_MIGRATION_TARGET_URL:
            testConfiguration().WIZPAY_MIGRATION_TARGET_URL + options,
        }),
      ).toThrow();
  });
  it('only accepts an explicit verified-TLS Supabase direct/session target', () => {
    const project = 'tsvzblikmgocgksgxguc';
    const env = {
      ...testConfiguration(),
      WIZPAY_MIGRATION_TARGET_PROJECT_REF: project,
      WIZPAY_MIGRATION_TARGET_URL: `postgresql://postgres:fake@db.${project}.supabase.co:5432/postgres?sslmode=verify-full`,
      WIZPAY_MIGRATION_TARGET_HOST: `db.${project}.supabase.co`,
      WIZPAY_MIGRATION_TARGET_DATABASE: 'postgres',
    };
    expect(rehearsalConfiguration(env).localTarget).toBe(false);
    expect(() =>
      rehearsalConfiguration({
        ...env,
        WIZPAY_MIGRATION_TARGET_PROJECT_REF: undefined,
      }),
    ).toThrow();
    expect(() =>
      rehearsalConfiguration({
        ...env,
        WIZPAY_MIGRATION_TARGET_URL: env.WIZPAY_MIGRATION_TARGET_URL.replace(
          'verify-full',
          'require',
        ),
      }),
    ).toThrow('verified TLS');
    expect(() =>
      rehearsalConfiguration({
        ...env,
        WIZPAY_MIGRATION_TARGET_URL: `postgresql://postgres.${project}:fake@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`,
      }),
    ).toThrow('Session');
  });
  it('keeps credentials out of native arguments and forces a read-only source session', () => {
    const env = nativeEnvironment(
      new URL(testConfiguration().WIZPAY_MIGRATION_SOURCE_URL),
      true,
    );
    expect(env.PGPASSWORD).toBe('fake');
    expect(env.PGOPTIONS).toContain('default_transaction_read_only=on');
    expect(env.PGCONNECT_TIMEOUT).toBe('10');
  });
  it('detects identity/state corruption even when counts still match', () => {
    const rows = compareSnapshots(
      { ExecutionIntent: { count: '1', digest: 'before' } },
      { ExecutionIntent: { count: '1', digest: 'after' } },
    );
    expect(rows[0]).toMatchObject({ match: true, integrity_match: false });
  });
  it('detects missing constraints/indexes/enums without copying values into reports', () => {
    const baseline = {
      columns: [],
      constraints: [{ name: 'critical' }],
      indexes: [{ name: 'unique' }],
      enums: [{ name: 'status' }],
      triggers: [],
    };
    const altered = { ...baseline, constraints: [], indexes: [], enums: [] };
    expect(catalogParity(baseline, altered)).toMatchObject({
      constraints: false,
      indexes: false,
      enums: false,
    });
  });
  it('keeps native database tooling independent of financial execution and backup files ignored', async () => {
    const names = [
      'migration-rehearsal.ts',
      'rehearsal-catalog.ts',
      'rehearsal-config.ts',
      'rehearsal-fixtures.ts',
    ];
    const text = (
      await Promise.all(
        names.map((name) =>
          readFile(join(backendRoot, 'src/phase7', name), 'utf8'),
        ),
      )
    ).join('\n');
    expect(text).not.toMatch(
      /from ['"](?:viem|bullmq|ioredis)|(?:signTransaction|sendTransaction|writeContract|runReconciliationBatch)\(/,
    );
    const ignore = await readFile(
      join(backendRoot, '../../.gitignore'),
      'utf8',
    );
    expect(ignore).toContain('*.dump');
    expect(ignore).toContain('*.backup');
    expect(ignore).toContain('.migration-rehearsal/');
  });
});
