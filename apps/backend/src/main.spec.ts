import { bootstrap } from './main';

describe('backend startup Arc readiness order', () => {
  it('fails before creating or listening when the selected network is incomplete', async () => {
    const createApplication = jest.fn();

    await expect(
      bootstrap(createApplication, { WIZPAY_ARC_NETWORK: 'arc-mainnet' }),
    ).rejects.toThrow('OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE');
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('validates readiness before listen for explicit Arc Testnet', async () => {
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

    await bootstrap(createApplication, {
      WIZPAY_ARC_NETWORK: 'arc-testnet',
      PORT: '0',
    });
    expect(events[0]).toBe('create');
    expect(events.at(-1)).toBe('listen');
  });
});
