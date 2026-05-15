import {
  BadRequestException,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircleAgentWalletSwapExecutor } from './executors/circle-agent-wallet-swap.executor';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';

describe('OfficialSwapOrchestrator', () => {
  const request = {
    sellToken: 'USDC',
    buyToken: 'EURC',
    sellAmount: '10',
    chain: 'ARC-TESTNET',
  };

  function createSubject(env: Record<string, string | undefined> = {}) {
    const configService = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    const executor = new CircleAgentWalletSwapExecutor();
    const orchestrator = new OfficialSwapOrchestrator(configService, executor);

    return { orchestrator };
  }

  it('fails quote closed when official swap is disabled by default', async () => {
    const { orchestrator } = createSubject();

    await expect(orchestrator.quote(request)).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_DISABLED',
      },
    });
    await expect(orchestrator.quote(request)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('fails execute closed when official swap is disabled by default', async () => {
    const { orchestrator } = createSubject();

    await expect(
      orchestrator.execute({ ...request, minOutput: '9.9' }),
    ).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_DISABLED',
      },
    });
  });

  it('rejects execute requests without minOutput before execution policy checks', async () => {
    const { orchestrator } = createSubject();

    await expect(
      orchestrator.execute({ ...request, minOutput: '' }),
    ).rejects.toMatchObject({
      response: {
        code: 'MIN_OUTPUT_REQUIRED',
      },
    });
    await expect(
      orchestrator.execute({ ...request, minOutput: '' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects unsupported chains when official swap is enabled', async () => {
    const { orchestrator } = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
    });

    await expect(
      orchestrator.quote({ ...request, chain: 'ETH-SEPOLIA' }),
    ).rejects.toMatchObject({
      response: {
        code: 'UNSUPPORTED_CHAIN',
      },
    });
  });

  it('rejects missing executor when official swap is enabled', async () => {
    const { orchestrator } = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
    });

    await expect(orchestrator.quote(request)).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_EXECUTOR_UNAVAILABLE',
      },
    });
  });

  it('does not execute a real swap when the placeholder executor is selected', async () => {
    const { orchestrator } = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'circle-agent-wallet',
    });

    await expect(
      orchestrator.execute({ ...request, minOutput: '9.9' }),
    ).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_NOT_IMPLEMENTED',
      },
    });
    await expect(
      orchestrator.execute({ ...request, minOutput: '9.9' }),
    ).rejects.toThrow(NotImplementedException);
  });
});
