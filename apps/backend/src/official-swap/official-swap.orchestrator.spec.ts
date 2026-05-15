import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircleAgentWalletSwapExecutor } from './executors/circle-agent-wallet-swap.executor';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';
import type {
  OfficialSwapExecuteRequest,
  OfficialSwapQuoteRequest,
} from './official-swap.types';

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

    const executor = {
      quote: jest.fn(),
      execute: jest.fn(),
    } as unknown as jest.Mocked<CircleAgentWalletSwapExecutor>;
    const orchestrator = new OfficialSwapOrchestrator(configService, executor);

    return { executor, orchestrator };
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

  it('rejects execute requests without walletAddress before execution policy checks', async () => {
    const { orchestrator } = createSubject();

    await expect(
      orchestrator.execute({ ...request, minOutput: '9.9' }),
    ).rejects.toMatchObject({
      response: {
        code: 'WALLET_ADDRESS_REQUIRED',
      },
    });
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

  it('blocks real execution unless testnet CLI is explicitly allowed', async () => {
    const { orchestrator } = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'circle-agent-wallet',
    });

    await expect(
      orchestrator.execute({
        ...request,
        minOutput: '9.9',
        walletAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'OFFICIAL_SWAP_TESTNET_CLI_DISABLED',
      },
    });
  });

  it('delegates quote when enabled, executor selected, and testnet CLI allowed', async () => {
    const { executor, orchestrator } = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'circle-agent-wallet',
      WIZPAY_OFFICIAL_SWAP_ALLOW_TESTNET_CLI: 'true',
    });
    const quoteResponse = {
      status: 'QUOTE_READY' as const,
      sellToken: 'USDC',
      buyToken: 'EURC',
      sellAmount: '10',
      chain: 'ARC-TESTNET' as const,
      estimatedOutput: '9.6',
      minOutput: '0.000001',
    };
    executor.quote.mockResolvedValue(quoteResponse);

    await expect(
      orchestrator.quote(request as OfficialSwapQuoteRequest),
    ).resolves.toBe(quoteResponse);
  });

  it('delegates execute when enabled, executor selected, and testnet CLI allowed', async () => {
    const { executor, orchestrator } = createSubject({
      WIZPAY_OFFICIAL_SWAP_ENABLED: 'true',
      WIZPAY_OFFICIAL_SWAP_EXECUTOR: 'circle-agent-wallet',
      WIZPAY_OFFICIAL_SWAP_ALLOW_TESTNET_CLI: 'true',
    });
    const executeRequest = {
      ...request,
      minOutput: '9.9',
      walletAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
    } satisfies OfficialSwapExecuteRequest;
    const executeResponse = {
      operationId: 'op-1',
      status: 'COMPLETE' as const,
      sellToken: 'USDC',
      buyToken: 'EURC',
      sellAmount: '10',
      minOutput: '9.9',
      chain: 'ARC-TESTNET' as const,
      txHashes: [],
      operations: [],
    };
    executor.execute.mockResolvedValue(executeResponse);

    await expect(
      orchestrator.execute(executeRequest),
    ).resolves.toBe(executeResponse);
  });
});
