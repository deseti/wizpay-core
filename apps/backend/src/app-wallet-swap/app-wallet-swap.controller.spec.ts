import { AppWalletSwapController } from './app-wallet-swap.controller';
import { AppWalletSwapService } from './app-wallet-swap.service';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_MODE,
  AppWalletSwapOperationResponse,
} from './app-wallet-swap.types';

const operationId = 'c3c25a1c-6c74-47a6-851a-03703c479b41';

function createPublicOperation(
  overrides: Partial<AppWalletSwapOperationResponse> = {},
): AppWalletSwapOperationResponse {
  return {
    operationId,
    operationMode: APP_WALLET_SWAP_MODE,
    sourceChain: APP_WALLET_SWAP_CHAIN,
    tokenIn: 'EURC',
    tokenOut: 'USDC',
    amountIn: '17000000',
    userWalletAddress: '0x1111111111111111111111111111111111111111',
    treasuryDepositAddress: '0x2222222222222222222222222222222222222222',
    expectedOutput: '16000000',
    minimumOutput: '15900000',
    expiresAt: '2026-07-21T12:00:00.000Z',
    status: 'completed',
    createdAt: '2026-07-21T11:00:00.000Z',
    updatedAt: '2026-07-21T11:05:00.000Z',
    executionEnabled: true,
    ...overrides,
  };
}

function collectForbiddenPublicPaths(
  value: unknown,
  path = 'response',
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectForbiddenPublicPaths(entry, `${path}[${index}]`),
    );
  }

  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      const entryPath = `${path}.${key}`;
      const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
      const forbidden =
        normalizedKey.includes('typeddata') ||
        normalizedKey.includes('signature') ||
        normalizedKey.includes('permit2') ||
        normalizedKey.includes('authorization') ||
        normalizedKey.includes('rawcircleresponse') ||
        entryPath.includes('.previous.previous');

      return [
        ...(forbidden ? [entryPath] : []),
        ...collectForbiddenPublicPaths(entry, entryPath),
      ];
    },
  );
}

describe('AppWalletSwapController public operation contract', () => {
  const appWalletSwapService = {
    getOperation: jest.fn(),
    toPublicOperation: jest.fn((operation: AppWalletSwapOperationResponse) => {
      const {
        rawQuote: _rawQuote,
        rawTreasurySwap: _rawTreasurySwap,
        rawPayout: _rawPayout,
        rawRefund: _rawRefund,
        ...publicOperation
      } = operation;
      return publicOperation;
    }),
  } as unknown as jest.Mocked<
    Pick<AppWalletSwapService, 'getOperation' | 'toPublicOperation'>
  >;
  const controller = new AppWalletSwapController(
    appWalletSwapService as unknown as AppWalletSwapService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the operation under the existing data envelope', async () => {
    const operation = createPublicOperation();
    appWalletSwapService.getOperation.mockResolvedValueOnce(operation);

    await expect(controller.getOperation(operationId)).resolves.toEqual({
      data: operation,
    });
    expect(appWalletSwapService.getOperation).toHaveBeenCalledWith(operationId);
    expect(appWalletSwapService.toPublicOperation).toHaveBeenCalledWith(
      operation,
    );
  });

  it('does not expose internal provider payloads through the public endpoint', async () => {
    const operation = createPublicOperation({
      rawTreasurySwap: {
        previous: {
          previous: {
            quote: {
              typedData: { message: { permit2: '[synthetic-permit2]' } },
              signature: '[synthetic-signature]',
            },
          },
        },
      },
      rawPayout: {
        rawCircleResponse: {
          authorizationPayload: '[synthetic-authorization-payload]',
        },
      },
    });
    appWalletSwapService.getOperation.mockResolvedValueOnce(operation);

    const response = await controller.getOperation(operationId);

    expect(collectForbiddenPublicPaths(response.data)).toEqual([]);
  });
});
