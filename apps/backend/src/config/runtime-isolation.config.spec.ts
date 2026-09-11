import { resolveRuntimeIsolationConfiguration } from './runtime-isolation.config';

const testnet = {
  WIZPAY_ARC_NETWORK: 'arc-testnet',
  ARC_TESTNET_DATABASE_URL:
    'postgresql://testnet_user:testnet_password@db-testnet.internal:5432/wizpay_testnet?sslmode=require',
  ARC_TESTNET_REDIS_URL:
    'rediss://testnet_user:testnet_password@redis-testnet.internal:6380/2',
  ARC_TESTNET_QUEUE_PREFIX: 'wizpay:arc-testnet',
};

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
      resolveRuntimeIsolationConfiguration(withoutSelector(testnet)),
    ).toThrow();
  });

  it('resolves only the selected Testnet targets', () => {
    const config = resolveRuntimeIsolationConfiguration({
      ...testnet,
      ...withoutSelector(mainnet),
    });
    expect(config.databaseUrl).toBe(testnet.ARC_TESTNET_DATABASE_URL);
    expect(config.redis).toMatchObject({
      host: 'redis-testnet.internal',
      port: 6380,
      databaseIndex: 2,
      tls: true,
    });
    expect(config.queuePrefix).toBe('wizpay:arc-testnet');
    expect(JSON.stringify(config.diagnostic)).not.toContain('password');
  });

  it('resolves only the selected Mainnet targets and remains non-transactional', () => {
    const config = resolveRuntimeIsolationConfiguration({
      ...mainnet,
      ...withoutSelector(testnet),
    });
    expect(config.databaseUrl).toBe(mainnet.ARC_MAINNET_DATABASE_URL);
    expect(config.queuePrefix).toBe('wizpay:arc-mainnet');
    expect(config.diagnostic).toMatchObject({
      manifest: 'arc-mainnet-unavailable',
      transactionalCapabilityAvailable: false,
      circle: { blockchainAvailable: false },
    });
  });

  it.each([
    { DATABASE_URL: testnet.ARC_TESTNET_DATABASE_URL },
    { REDIS_URL: testnet.ARC_TESTNET_REDIS_URL },
    { WIZPAY_WORKER_NETWORK: 'arc-mainnet' },
  ])('fails closed for missing, legacy, or conflicting values: %p', (extra) => {
    expect(() =>
      resolveRuntimeIsolationConfiguration({ ...testnet, ...extra }),
    ).toThrow();
  });

  it('rejects identical normalized database targets without exposing secrets', () => {
    const action = () =>
      resolveRuntimeIsolationConfiguration({
        ...testnet,
        ARC_MAINNET_DATABASE_URL:
          'postgresql://testnet_user:different_secret@DB-TESTNET.INTERNAL/wizpay_testnet',
      });
    expect(action).toThrow('database targets must be distinct');
    try {
      action();
    } catch (error) {
      expect(String(error)).not.toContain('testnet_password');
      expect(String(error)).not.toContain('different_secret');
    }
  });

  it('rejects identical Redis targets and empty, generic, or shared prefixes', () => {
    expect(() =>
      resolveRuntimeIsolationConfiguration({
        ...testnet,
        ARC_MAINNET_REDIS_URL:
          'rediss://testnet_user:other@REDIS-TESTNET.INTERNAL:6380/2',
      }),
    ).toThrow('Redis targets must be distinct');
    for (const prefix of ['', 'wizpay', 'wizpay:arc-mainnet']) {
      expect(() =>
        resolveRuntimeIsolationConfiguration({
          ...testnet,
          ARC_TESTNET_QUEUE_PREFIX: prefix,
        }),
      ).toThrow();
    }
    expect(() =>
      resolveRuntimeIsolationConfiguration({
        ...testnet,
        ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-testnet',
      }),
    ).toThrow('queue prefixes must be distinct');
  });

  it('reports Circle presence only as booleans', () => {
    const config = resolveRuntimeIsolationConfiguration({
      ...testnet,
      CIRCLE_TESTNET_API_KEY: 'top-secret-api-key',
      CIRCLE_TESTNET_ENTITY_SECRET: 'top-secret-entity-secret',
      CIRCLE_TESTNET_WALLET_SET_ID: 'wallet-set-private',
    });
    expect(config.diagnostic.circle).toMatchObject({
      apiCredentialConfigured: true,
      entitySecretConfigured: true,
      walletSetConfigured: true,
      blockchainAvailable: true,
    });
    const serialized = JSON.stringify(config.diagnostic);
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('wallet-set-private');
  });
});

function withoutSelector(values: Record<string, string>) {
  const rest = { ...values };
  delete rest.WIZPAY_ARC_NETWORK;
  return rest;
}
