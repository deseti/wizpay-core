import { ConfigService } from '@nestjs/config';
import { OfficialSwapRuntimeService } from './official-swap-runtime.service';

describe('OfficialSwapRuntimeService', () => {
  function createSubject(
    env: Record<string, string | undefined>,
    commandRunner: jest.Mock,
  ) {
    const configService = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    const service = new OfficialSwapRuntimeService(configService);
    service.setCommandRunnerForTest(commandRunner);

    return service;
  }

  it('reports Circle CLI availability and sanitized config state', async () => {
    const commandRunner = jest.fn().mockResolvedValue({});
    const service = createSubject(
      {
        WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
        WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'circle-agent-wallet',
      },
      commandRunner,
    );

    await expect(service.getRuntimeStatus()).resolves.toEqual({
      circleCliAvailable: true,
      executorConfigured: 'circle-agent-wallet',
      enabled: true,
      chain: 'ARC-TESTNET',
    });
    expect(commandRunner).toHaveBeenCalledWith('which', ['circle'], {
      timeout: 2000,
    });
  });

  it('fails closed when Circle CLI is unavailable', async () => {
    const commandRunner = jest.fn().mockRejectedValue(new Error('missing'));
    const service = createSubject({}, commandRunner);

    await expect(service.getRuntimeStatus()).resolves.toEqual({
      circleCliAvailable: false,
      executorConfigured: 'disabled',
      enabled: false,
      chain: 'ARC-TESTNET',
    });
  });

  it('does not expose unsupported executor environment values', async () => {
    const commandRunner = jest.fn().mockResolvedValue({});
    const service = createSubject(
      {
        WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'do-not-echo-this-value',
      },
      commandRunner,
    );

    await expect(service.getRuntimeStatus()).resolves.toMatchObject({
      executorConfigured: 'unsupported',
    });
  });
});
