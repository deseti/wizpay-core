import { createWizPayApplication } from './application';
import { bootstrap } from './main';
import { resolveRuntimeMode } from './runtime/runtime.module';

const environment = {
  WIZPAY_ARC_NETWORK: 'arc-mainnet',
  ARC_MAINNET_DATABASE_URL:
    'postgresql://test:test@127.0.0.1:15432/wizpay_arc_mainnet',
  ARC_MAINNET_REDIS_URL: 'redis://127.0.0.1:6379/1',
  ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-mainnet',
  PORT: '0',
};

function fixture() {
  const app = {
    enableCors: jest.fn(),
    enableShutdownHooks: jest.fn(),
    listen: jest.fn().mockResolvedValue(undefined),
    init: jest.fn(),
  };
  const createApplication = jest.fn().mockResolvedValue(app);
  return { app, createApplication };
}

describe('shared HTTP application construction', () => {
  it.each(['server', 'serverless'] as const)(
    'configures %s without owning a listener or signals',
    async (runtimeMode) => {
      const { app, createApplication } = fixture();
      await createWizPayApplication({
        environment,
        runtimeMode,
        createApplication,
      });
      expect(createApplication).toHaveBeenCalledWith(runtimeMode);
      expect(app.enableCors).toHaveBeenCalledWith({
        origin: ['http://localhost:3000', 'http://localhost:3001'],
        credentials: true,
      });
      expect(app.listen).not.toHaveBeenCalled();
      expect(app.enableShutdownHooks).not.toHaveBeenCalled();
      expect(app.init).not.toHaveBeenCalled();
    },
  );

  it('leaves listener and shutdown hook ownership to the long-lived entrypoint', async () => {
    const { app, createApplication } = fixture();
    await bootstrap(createApplication, environment);
    expect(createApplication).toHaveBeenCalledWith('server');
    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledWith('0');
  });

  it('rejects invalid runtime modes before constructing an application', async () => {
    const { createApplication } = fixture();
    await expect(
      createWizPayApplication({
        environment: { ...environment, WIZPAY_RUNTIME_MODE: 'invalid' },
        createApplication,
      }),
    ).rejects.toThrow('must be server or serverless');
    expect(createApplication).not.toHaveBeenCalled();
  });

  it.each(['server', 'serverless'] as const)(
    'rejects a selector conflicting with the %s entrypoint',
    async (runtimeMode) => {
      const { createApplication } = fixture();
      await expect(
        createWizPayApplication({
          environment: {
            ...environment,
            WIZPAY_RUNTIME_MODE:
              runtimeMode === 'server' ? 'serverless' : 'server',
          },
          runtimeMode,
          createApplication,
        }),
      ).rejects.toThrow('does not match');
      expect(createApplication).not.toHaveBeenCalled();
    },
  );

  it('validates production CORS before creating either runtime', async () => {
    const { createApplication } = fixture();
    await expect(
      createWizPayApplication({
        environment: {
          ...environment,
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://wrong.example',
        },
        createApplication,
      }),
    ).rejects.toThrow('Production CORS_ORIGINS');
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('defaults to the existing server mode and rejects empty values', () => {
    expect(resolveRuntimeMode(undefined)).toBe('server');
    expect(() => resolveRuntimeMode('')).toThrow();
    expect(() => resolveRuntimeMode('SERVER')).toThrow();
  });
});
