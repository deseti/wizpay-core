import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';

describe('OfficialSwapOrchestrator (Mainnet fail-closed)', () => {
  const request = {
    sellToken: 'USDC',
    buyToken: 'EURC',
    sellAmount: '10',
    chain: 'ARC-MAINNET',
  };

  function createSubject(env: Record<string, string | undefined> = {}) {
    const configService = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    return new OfficialSwapOrchestrator(configService);
  }

  function enabledSubject(env: Record<string, string | undefined> = {}) {
    return createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'mainnet-uniswap-v4',
      ...env,
    });
  }

  it('fails quote closed when official swap is disabled by default', async () => {
    const orchestrator = createSubject();

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
    const orchestrator = createSubject();

    await expect(
      orchestrator.execute({
        ...request,
        minOutput: '9.9',
        walletAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_DISABLED',
      },
    });
  });

  it('fails quote closed without backend submission when enabled', async () => {
    const orchestrator = enabledSubject();

    await expect(orchestrator.quote(request)).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_QUOTE_FAILED',
      },
    });
  });

  it('fails execute closed without backend submission when enabled', async () => {
    const orchestrator = enabledSubject();

    await expect(
      orchestrator.execute({
        ...request,
        minOutput: '9.9',
        walletAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_EXECUTION_FAILED',
      },
    });
  });

  it('requires minOutput and walletAddress before execution guards', async () => {
    const orchestrator = enabledSubject();

    await expect(
      orchestrator.execute({ ...request, minOutput: '  ' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      orchestrator.execute({ ...request, minOutput: '9.9' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects non-Mainnet chains', async () => {
    const orchestrator = enabledSubject();

    await expect(
      orchestrator.quote({ ...request, chain: 'ARC-LEGACY' }),
    ).rejects.toMatchObject({
      response: {
        code: 'UNSUPPORTED_CHAIN',
      },
    });
  });

  it('rejects unavailable executors', async () => {
    const orchestrator = enabledSubject({
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'legacy-executor',
    });

    await expect(orchestrator.quote(request)).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_EXECUTOR_UNAVAILABLE',
      },
    });
  });

  it('returns a not-implemented status payload', () => {
    const orchestrator = enabledSubject();

    expect(orchestrator.getStatus('op-1')).toMatchObject({
      operationId: 'op-1',
      status: 'NOT_IMPLEMENTED',
      chain: 'ARC-MAINNET',
    });
  });
});
