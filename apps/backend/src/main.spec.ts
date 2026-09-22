import {
  bootstrap,
  resolveCorsOrigins,
  WIZPAY_PRODUCTION_APP_ORIGIN,
} from './main';

const mainnetEnv = {
  WIZPAY_ARC_NETWORK: 'arc-mainnet',
  ARC_MAINNET_DATABASE_URL:
    'postgresql://wizpay_mainnet:secret@127.0.0.1:15432/wizpay_arc_mainnet',
  ARC_MAINNET_REDIS_URL: 'redis://127.0.0.1:6379/1',
  ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-mainnet',
  PORT: '0',
};

describe('backend startup Arc readiness order', () => {
  it('fails before creating or listening when Mainnet isolation env is incomplete', async () => {
    const createApplication = jest.fn();

    await expect(
      bootstrap(createApplication, { WIZPAY_ARC_NETWORK: 'arc-mainnet' }),
    ).rejects.toThrow();
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('fails before creating when the Arc network selector is not Mainnet', async () => {
    const createApplication = jest.fn();

    await expect(
      bootstrap(createApplication, {
        ...mainnetEnv,
        WIZPAY_ARC_NETWORK: 'unknown',
      }),
    ).rejects.toThrow();
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('validates readiness before listen for explicit Arc Mainnet', async () => {
    const events: string[] = [];
    const app = {
      enableShutdownHooks: jest.fn(() => events.push('configure')),
      enableCors: jest.fn(() => events.push('configure')),
      listen: jest.fn(async () => {
        events.push('listen');
      }),
    };
    const createApplication = jest.fn(async () => {
      events.push('create');
      return app as never;
    });

    await bootstrap(createApplication, { ...mainnetEnv });
    expect(events[0]).toBe('create');
    expect(events.at(-1)).toBe('listen');
  });
});

describe('backend production CORS isolation', () => {
  it('allows only the confirmed Vercel production origin', () => {
    expect(
      resolveCorsOrigins({
        NODE_ENV: 'production',
        CORS_ORIGINS: WIZPAY_PRODUCTION_APP_ORIGIN,
      }),
    ).toEqual([WIZPAY_PRODUCTION_APP_ORIGIN]);
  });

  it.each([
    undefined,
    '',
    'http://localhost:3000',
    'https://app.wizpay.xyz,https://admin.wizpay.xyz',
    'https://app.wizpay.xyz/',
  ])('rejects an inexact production CORS origin: %p', (value) => {
    expect(() =>
      resolveCorsOrigins({ NODE_ENV: 'production', CORS_ORIGINS: value }),
    ).toThrow(`exactly ${WIZPAY_PRODUCTION_APP_ORIGIN}`);
  });
});
