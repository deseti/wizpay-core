import { resolveRuntimeIsolationConfiguration } from './runtime-isolation.config';

const mainnet = {
  WIZPAY_ARC_NETWORK: 'arc-mainnet',
  ARC_MAINNET_DATABASE_URL:
    'postgresql://mainnet_user:mainnet_password@db-mainnet.internal:5432/wizpay_mainnet?sslmode=require',
  ARC_MAINNET_REDIS_URL:
    'rediss://mainnet_user:mainnet_password@redis-mainnet.internal:6380/3',
  ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-mainnet',
};

describe('runtime isolation configuration', () => {
  it('rejects a missing network selector', () => {
    expect(() =>
      resolveRuntimeIsolationConfiguration(withoutSelector(mainnet)),
    ).toThrow();
  });

  it.each([undefined, '', ' arc-mainnet ', 'ARC-MAINNET', 'unknown'])(
    'rejects a missing or inexact network selector: %p',
    (selector) => {
      expect(() =>
        resolveRuntimeIsolationConfiguration({
          ...mainnet,
          WIZPAY_ARC_NETWORK: selector,
        }),
      ).toThrow();
    },
  );

  it('resolves only the selected Mainnet targets', () => {
    const config = resolveRuntimeIsolationConfiguration({ ...mainnet });
    expect(config.network).toBe('arc-mainnet');
    expect(config.databaseUrl).toBe(mainnet.ARC_MAINNET_DATABASE_URL);
    expect(config.redis).toMatchObject({
      host: 'redis-mainnet.internal',
      port: 6380,
      databaseIndex: 3,
      tls: true,
    });
    expect(config.queuePrefix).toBe('wizpay:arc-mainnet');
    expect(config.diagnostic).toMatchObject({
      network: 'arc-mainnet',
      environment: 'mainnet',
      manifest: 'arc-mainnet-unavailable',
    });
    expect(JSON.stringify(config.diagnostic)).not.toContain('mainnet_password');
  });

  it.each([
    { DATABASE_URL: mainnet.ARC_MAINNET_DATABASE_URL },
    { REDIS_URL: mainnet.ARC_MAINNET_REDIS_URL },
    { QUEUE_PREFIX: 'wizpay:arc-mainnet' },
    { WIZPAY_API_NETWORK: 'unknown' },
    { WIZPAY_WORKER_NETWORK: 'unknown' },
  ])('fails closed for missing, legacy, or conflicting values: %p', (extra) => {
    expect(() =>
      resolveRuntimeIsolationConfiguration({ ...mainnet, ...extra }),
    ).toThrow();
  });

  it('rejects retired network configuration without reading it', () => {
    expect(() =>
      resolveRuntimeIsolationConfiguration({
        ...mainnet,
        WIZPAY_RETIRED_TESTNET_MODE: 'enabled',
      }),
    ).toThrow('Legacy network configuration');
  });

  it('rejects custodied-wallet configuration on the external-wallet-only runtime', () => {
    expect(() =>
      resolveRuntimeIsolationConfiguration({
        ...mainnet,
        'CIRCLE-RETIRED-API-KEY': 'top-secret-api-key',
      }),
    ).toThrow('is not accepted');
  });

  it('rejects incomplete, non-PostgreSQL, or invalid-port database targets', () => {
    for (const databaseUrl of [
      'redis://mainnet_user:secret@db-mainnet.internal:5432/wizpay_mainnet',
      'postgresql://db-mainnet.internal:5432/wizpay_mainnet',
      'postgresql://mainnet_user:secret@db-mainnet.internal:99999/wizpay_mainnet',
      'not-a-url',
    ]) {
      expect(() =>
        resolveRuntimeIsolationConfiguration({
          ...mainnet,
          ARC_MAINNET_DATABASE_URL: databaseUrl,
        }),
      ).toThrow();
    }
  });

  it('rejects invalid Redis targets and empty, generic, or off-network prefixes', () => {
    expect(() =>
      resolveRuntimeIsolationConfiguration({
        ...mainnet,
        ARC_MAINNET_REDIS_URL: 'postgresql://redis-mainnet.internal:6380/3',
      }),
    ).toThrow('must be a Redis URL');
    for (const prefix of ['', 'wizpay', 'wizpay:mainnet-ops']) {
      expect(() =>
        resolveRuntimeIsolationConfiguration({
          ...mainnet,
          ARC_MAINNET_QUEUE_PREFIX: prefix,
        }),
      ).toThrow();
    }
  });
});

function withoutSelector(values: Record<string, string>) {
  const rest = { ...values };
  delete rest.WIZPAY_ARC_NETWORK;
  return rest;
}
