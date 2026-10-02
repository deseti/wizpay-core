import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('remote Phase 2 validator fail-closed boundary', () => {
  const password = 'synthetic-secret-must-never-appear';
  const host = 'validation.example.pooler.supabase.com';
  const session = `postgresql://synthetic_user:${password}@${host}:5432/postgres?sslmode=verify-full`;
  const runtime = session.replace(':5432/', ':6543/');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
    WIZPAY_DATABASE_PROFILE: 'supavisor-transaction',
    WIZPAY_MIGRATION_DATABASE_MODE: 'session',
    WIZPAY_ARC_NETWORK: 'arc-mainnet',
    WIZPAY_MIGRATION_NETWORK: 'arc-mainnet',
    WIZPAY_EXTERNAL_TEST_ACK: 'ISOLATED_NONPRODUCTION_SCHEMA',
    WIZPAY_EXTERNAL_TEST_TARGET_DATABASE: 'postgres',
    WIZPAY_EXTERNAL_TEST_TARGET_HOST: host,
    WIZPAY_EXTERNAL_TEST_RUNTIME_TARGET_HOST: host,
    WIZPAY_EXTERNAL_TEST_DATABASE_URL: session,
    WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL: runtime,
    WIZPAY_EXTERNAL_TEST_CA_PEM: undefined,
    ARC_MAINNET_DATABASE_URL: undefined,
    DATABASE_URL: undefined,
    DIRECT_URL: undefined,
    EXECUTION_INTENT_TEST_DATABASE_URL: undefined,
    PHASE7_TEST_DATABASE_URL: undefined,
  };

  it.each([
    { WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL: undefined },
    { WIZPAY_EXTERNAL_TEST_ACK: 'not-authorized' },
    { WIZPAY_EXTERNAL_TEST_TARGET_HOST: 'wrong.example.invalid' },
    {
      WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL: runtime.replace(
        'verify-full',
        'require',
      ),
    },
    { NODE_ENV: 'production' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ])(
    'rejects unsafe bindings before connections or migrations without printing credentials (%#)',
    (overrides) => {
      const result = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register', 'test/validate-live-supabase.ts'],
        {
          cwd: join(__dirname, '../..'),
          env: { ...environment, ...overrides },
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain('"stage":"configuration"');
      expect(output).toContain('"result":"FAIL"');
      expect(output).not.toContain('preflight');
      expect(output).not.toContain('migration deploy');
      expect(output).not.toContain(password);
      expect(output).not.toContain(session);
      expect(output).not.toContain(runtime);
      expect(output).not.toContain('synthetic_user');
    },
    20_000,
  );
});
