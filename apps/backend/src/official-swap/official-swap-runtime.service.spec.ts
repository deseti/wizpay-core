import { ConfigService } from '@nestjs/config';
import { OfficialSwapRuntimeService } from './official-swap-runtime.service';

describe('OfficialSwapRuntimeService (Mainnet only)', () => {
  function createSubject(env: Record<string, string | undefined>) {
    const configService = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    return new OfficialSwapRuntimeService(configService);
  }

  it('reports Mainnet readiness and sanitized config state', async () => {
    const service = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'mainnet-uniswap-v4',
    });

    await expect(service.getRuntimeStatus()).resolves.toEqual({
      readinessAvailable: true,
      executorConfigured: 'mainnet-uniswap-v4',
      enabled: true,
      chain: 'ARC-MAINNET',
    });
  });

  it('reports disabled executor by default', async () => {
    const service = createSubject({});

    await expect(service.getRuntimeStatus()).resolves.toMatchObject({
      executorConfigured: 'disabled',
      enabled: false,
      chain: 'ARC-MAINNET',
    });
  });

  it('reports unsupported executors without executing anything', async () => {
    const service = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'legacy-executor',
    });

    await expect(service.getRuntimeStatus()).resolves.toMatchObject({
      executorConfigured: 'unsupported',
    });
  });
});
