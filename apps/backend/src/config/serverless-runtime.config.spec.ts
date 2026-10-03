import { validateEnvironment } from './env.validation';
import { resolveRuntimeIsolationConfiguration } from './runtime-isolation.config';
import { AppConfigModule } from './app-config.module';

const databaseEnvironment = {
  WIZPAY_ARC_NETWORK: 'arc-mainnet',
  ARC_MAINNET_DATABASE_URL:
    'postgresql://test:test@127.0.0.1:15432/wizpay_arc_mainnet',
};

describe('runtime-specific Redis configuration', () => {
  it('accepts serverless configuration with no Redis variables and derives no Redis settings', () => {
    const config = validateEnvironment({
      ...databaseEnvironment,
      WIZPAY_RUNTIME_MODE: 'serverless',
    });
    expect(config.DATABASE_URL).toBe(
      databaseEnvironment.ARC_MAINNET_DATABASE_URL,
    );
    for (const key of [
      'REDIS_URL',
      'REDIS_HOST',
      'REDIS_PORT',
      'REDIS_DB',
      'BULLMQ_PREFIX',
    ]) {
      expect(config).not.toHaveProperty(key);
    }
    expect(config.RUNTIME_ISOLATION_DIAGNOSTIC).not.toHaveProperty('redis');
    expect(config.RUNTIME_ISOLATION_DIAGNOSTIC).not.toHaveProperty(
      'queuePrefix',
    );
  });

  it('does not consume irrelevant optional scoped Redis settings in serverless mode', () => {
    const config = resolveRuntimeIsolationConfiguration({
      ...databaseEnvironment,
      WIZPAY_RUNTIME_MODE: 'serverless',
      ARC_MAINNET_REDIS_URL: 'unreachable-and-unused',
      ARC_MAINNET_QUEUE_PREFIX: 'unused',
    });
    expect(config.redis).toBeUndefined();
    expect(config.redisUrl).toBeUndefined();
    expect(config.queuePrefix).toBeUndefined();
  });

  it.each([undefined, 'server'])(
    'requires Redis for the legacy server mode %p',
    (mode) => {
      expect(() =>
        validateEnvironment({
          ...databaseEnvironment,
          WIZPAY_RUNTIME_MODE: mode,
        }),
      ).toThrow('ARC_MAINNET_REDIS_URL is required');
    },
  );

  it('retains legacy Redis settings and queue-prefix validation', () => {
    const config = validateEnvironment({
      ...databaseEnvironment,
      WIZPAY_RUNTIME_MODE: 'server',
      ARC_MAINNET_REDIS_URL: 'redis://127.0.0.1:6379/2',
      ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-mainnet',
    });
    expect(config.REDIS_HOST).toBe('127.0.0.1');
    expect(config.REDIS_DB).toBe('2');
    expect(config.BULLMQ_PREFIX).toBe('wizpay:arc-mainnet');
    expect(() =>
      validateEnvironment({
        ...databaseEnvironment,
        WIZPAY_RUNTIME_MODE: 'server',
        ARC_MAINNET_REDIS_URL: 'redis://127.0.0.1:6379/2',
      }),
    ).toThrow('ARC_MAINNET_QUEUE_PREFIX is required');
  });

  it.each(['invalid', '', 'SERVERLESS'])(
    'rejects invalid runtime selectors %p',
    (mode) => {
      expect(() =>
        validateEnvironment({
          ...databaseEnvironment,
          WIZPAY_RUNTIME_MODE: mode,
        }),
      ).toThrow('must be server or serverless');
    },
  );

  it.each([
    { DATABASE_URL: databaseEnvironment.ARC_MAINNET_DATABASE_URL },
    { DIRECT_URL: databaseEnvironment.ARC_MAINNET_DATABASE_URL },
    { REDIS_URL: 'redis://127.0.0.1:6379' },
    { WIZPAY_ARC_NETWORK: 'unknown' },
    { CIRCLE_API_KEY: 'forbidden-test-value' },
    { ARC_MAINNET_DATABASE_URL: 'invalid' },
  ])(
    'keeps database, network and fund-authority guards closed: %p',
    (extra) => {
      expect(() =>
        validateEnvironment({
          ...databaseEnvironment,
          WIZPAY_RUNTIME_MODE: 'serverless',
          ...extra,
        }),
      ).toThrow();
    },
  );

  it('rejects an invalid module runtime before loading configuration', () => {
    expect(() => AppConfigModule.forRuntime('invalid' as never)).toThrow(
      'must be server or serverless',
    );
  });
});
