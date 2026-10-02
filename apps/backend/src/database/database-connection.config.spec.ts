import { PrismaPg } from '@prisma/adapter-pg';
import {
  migrationDatabaseUrl,
  runtimeDatabasePool,
} from './database-connection.config';
import { validateEnvironment } from '../config/env.validation';

const runtime =
  'postgresql://test_user:test_password@runtime.example.invalid:6543/postgres?sslmode=verify-full';
const migration =
  'postgresql://test_user:test_password@migration.example.invalid:5432/postgres?sslmode=verify-full';
const external = { WIZPAY_DATABASE_PROFILE: 'supavisor-transaction' };
const cli = {
  ...external,
  WIZPAY_ARC_NETWORK: 'arc-mainnet',
  WIZPAY_MIGRATION_NETWORK: 'arc-mainnet',
  WIZPAY_MIGRATION_DATABASE_MODE: 'session',
  ARC_MAINNET_DATABASE_URL: runtime,
  ARC_MAINNET_MIGRATION_DATABASE_URL: migration,
};

describe('database connection purposes', () => {
  it('preserves VPS configuration and the explicit legacy shared direct connection', () => {
    expect(runtimeDatabasePool(runtime, {})).toEqual({
      connectionString: runtime,
    });
    expect(
      migrationDatabaseUrl({
        WIZPAY_ARC_NETWORK: 'arc-mainnet',
        WIZPAY_MIGRATION_NETWORK: 'arc-mainnet',
        ARC_MAINNET_DATABASE_URL: runtime,
      }),
    ).toBe(runtime);
  });

  it('bounds the transaction pool, verifies certificates and ignores no URL overrides', () => {
    expect(runtimeDatabasePool(runtime, external)).toMatchObject({
      host: 'runtime.example.invalid',
      max: 1,
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
    });
    expect(
      runtimeDatabasePool(runtime, {
        ...external,
        WIZPAY_DATABASE_POOL_MAX: '3',
      }).max,
    ).toBe(3);
    for (const max of ['0', '4', '10', '1.5', ' 1', ''])
      expect(() =>
        runtimeDatabasePool(runtime, {
          ...external,
          WIZPAY_DATABASE_POOL_MAX: max,
        }),
      ).toThrow();
    for (const options of [
      'sslmode=disable',
      'sslmode=require',
      'sslmode=verify-ca',
      'sslmode=verify-full&ssl=false',
      'sslmode=verify-full&options=-c%20search_path=public',
      'sslmode=verify-full&max=100',
      'sslmode=verify-full&uselibpqcompat=true',
    ])
      expect(() =>
        runtimeDatabasePool(runtime.split('?')[0] + '?' + options, external),
      ).toThrow();
  });

  it('selects only an explicit direct/session migration endpoint and does not require runtime credentials', () => {
    const nativeUrl = migration.replace(
      'sslmode=verify-full',
      'sslmode=require&sslaccept=strict',
    );
    expect(migrationDatabaseUrl(cli)).toBe(nativeUrl);
    expect(
      migrationDatabaseUrl({ ...cli, ARC_MAINNET_DATABASE_URL: undefined }),
    ).toBe(nativeUrl);
    expect(
      migrationDatabaseUrl({
        ...cli,
        WIZPAY_MIGRATION_DATABASE_MODE: 'direct',
      }),
    ).toBe(nativeUrl);
    for (const extra of [
      { ARC_MAINNET_MIGRATION_DATABASE_URL: undefined },
      { ARC_MAINNET_MIGRATION_DATABASE_URL: '' },
      { ARC_MAINNET_MIGRATION_DATABASE_URL: runtime },
      { WIZPAY_MIGRATION_DATABASE_MODE: 'transaction' },
      { WIZPAY_MIGRATION_DATABASE_MODE: undefined },
      { WIZPAY_MIGRATION_NETWORK: 'other' },
      { DATABASE_URL: migration },
      { DIRECT_URL: migration },
      {
        ARC_MAINNET_MIGRATION_DATABASE_URL:
          'postgresql://u:p@aws.example.pooler.supabase.com:6543/postgres?sslmode=verify-full',
      },
    ])
      expect(() => migrationDatabaseUrl({ ...cli, ...extra })).toThrow();
  });

  it('rejects invalid profiles, generic URLs, insecure settings and VPS hostname rewriting', () => {
    const env = {
      ...external,
      WIZPAY_ARC_NETWORK: 'arc-mainnet',
      ARC_MAINNET_DATABASE_URL: runtime,
      ARC_MAINNET_REDIS_URL: 'redis://localhost:6379/0',
      ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-mainnet',
    };
    expect(validateEnvironment(env).DATABASE_URL).toBe(runtime);
    expect(() =>
      validateEnvironment({ ...env, DIRECT_URL: migration }),
    ).toThrow();
    expect(() =>
      validateEnvironment({ ...env, DATABASE_URL: runtime }),
    ).toThrow();
    expect(() =>
      validateEnvironment({ ...env, WIZPAY_DATABASE_PROFILE: 'unknown' }),
    ).toThrow();
    expect(() =>
      runtimeDatabasePool(
        runtime.replace(
          'runtime.example.invalid',
          'aws.example.pooler.supabase.com',
        ),
        {},
      ),
    ).toThrow();
    expect(() =>
      validateEnvironment({
        ...env,
        ARC_MAINNET_DATABASE_URL:
          'postgresql://u:p@postgres:5432/db?sslmode=verify-full',
      }),
    ).toThrow();
    expect(() => runtimeDatabasePool('not-a-url-password', external)).toThrow(
      'ARC_MAINNET_DATABASE_URL',
    );
    try {
      runtimeDatabasePool('not-a-url-password', external);
    } catch (error) {
      expect(String(error)).not.toContain('not-a-url-password');
    }
  });
});

describe('installed PrismaPg transaction-pool contract', () => {
  it('uses unnamed queries and pins isolation/queries to one transaction client', async () => {
    const factory = new PrismaPg(runtimeDatabasePool(runtime, external));
    const adapter = await factory.connect();
    const pool = adapter.underlyingDriver();
    const query = jest
      .spyOn(pool, 'query')
      .mockResolvedValue({ rowCount: 1 } as never);
    await adapter.executeRaw({ sql: 'SELECT 1', args: [], argTypes: [] });
    expect(query.mock.calls[0][0]).toMatchObject({
      text: 'SELECT 1',
      name: undefined,
    });
    const client = {
      query: jest
        .fn<Promise<{ rowCount: number }>, [{ text: string; name?: string }]>()
        .mockResolvedValue({ rowCount: 1 }),
      on: jest.fn(),
      removeListener: jest.fn(),
      release: jest.fn(),
    };
    jest.spyOn(pool, 'connect').mockResolvedValue(client as never);
    const tx = await adapter.startTransaction('SERIALIZABLE');
    await tx.executeRaw({
      sql: 'UPDATE test SET value = 1',
      args: [],
      argTypes: [],
    });
    expect(client.query.mock.calls.map(([q]) => q.text)).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'UPDATE test SET value = 1',
    ]);
    expect(client.query.mock.calls.every(([q]) => q.name === undefined)).toBe(
      true,
    );
    await tx.rollback();
    expect(client.release).toHaveBeenCalledTimes(1);
    await adapter.dispose();
    expect(pool.ended).toBe(true);
  });
});
