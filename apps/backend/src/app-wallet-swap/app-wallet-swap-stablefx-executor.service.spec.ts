import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppWalletSwapOperation } from '@prisma/client';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapModule } from './app-wallet-swap.module';
import { mapAppWalletSwapOperationRecord } from './app-wallet-swap-operation.mapper';
import { AppWalletSwapOperationRepository } from './app-wallet-swap-operation.repository';
import {
  AppWalletSwapStablefxExecutorService,
  AppWalletSwapStablefxResponseError,
} from './app-wallet-swap-stablefx-executor.service';
import {
  APP_WALLET_SWAP_CHAIN,
  AppWalletSwapOperationResponse,
} from './app-wallet-swap.types';

const TREASURY_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_ADDRESS = '0xcccccccccccccccccccccccccccccccccccccccc';
const PERMIT2_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MESSAGE_SPENDER = '0xdddddddddddddddddddddddddddddddddddddddd';
const SETTLEMENT_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111';
const INTERMEDIATE_HASH =
  '0x2222222222222222222222222222222222222222222222222222222222222222';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SUBMITTED_AT = new Date('2099-01-01T00:00:00.000Z');

function createOperation(
  overrides: Partial<AppWalletSwapOperation> = {},
): AppWalletSwapOperation {
  return {
    operationId: OPERATION_ID,
    operationMode: 'treasury-mediated',
    sourceChain: APP_WALLET_SWAP_CHAIN,
    tokenIn: 'EURC',
    tokenOut: 'USDC',
    amountIn: '17000000',
    userWalletAddress: USER_ADDRESS,
    treasuryDepositAddress: TREASURY_ADDRESS,
    expectedOutput: null,
    minimumOutput: '16000000',
    expiresAt: '2099-01-01T00:05:00.000Z',
    status: 'deposit_confirmed',
    executionProvider: 'stablefx',
    quoteId: 'quote-1',
    rawQuote: { provider: 'stablefx' },
    depositTxHash: SETTLEMENT_HASH,
    circleTransactionId: null,
    circleReferenceId: null,
    circleWalletId: null,
    depositSubmittedAt: SUBMITTED_AT,
    depositConfirmedAt: SUBMITTED_AT,
    depositConfirmedAmount: '17000000',
    depositConfirmationError: null,
    executionEnabled: true,
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    treasurySwapId: null,
    treasurySwapQuoteId: null,
    treasurySwapTxHash: null,
    treasurySwapSubmittedAt: null,
    treasurySwapConfirmedAt: null,
    treasurySwapExpectedOutput: null,
    treasurySwapActualOutput: null,
    rawTreasurySwap: null,
    stablefxFundingRequestedAt: null,
    stablefxFundedAt: null,
    payoutTxHash: null,
    payoutAmount: null,
    payoutSubmittedAt: null,
    payoutConfirmedAt: null,
    rawPayout: null,
    refundTransactionId: null,
    refundTxHash: null,
    refundAmount: null,
    refundSubmittedAt: null,
    refundConfirmedAt: null,
    rawRefund: null,
    completedAt: null,
    executionError: null,
    createdAt: SUBMITTED_AT,
    updatedAt: SUBMITTED_AT,
    ...overrides,
  } as AppWalletSwapOperation;
}

describe('AppWalletSwapStablefxExecutorService', () => {
  const stablefxExecutionService = {
    createTradableQuote: jest.fn(),
    createTrade: jest.fn(),
    createFundingPresign: jest.fn(),
    fund: jest.fn(),
    getTrade: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      StablefxExecutionService,
      | 'createTradableQuote'
      | 'createTrade'
      | 'createFundingPresign'
      | 'fund'
      | 'getTrade'
    >
  >;
  const circleExecutor = {
    ensureTokenAllowance: jest.fn(),
    signTypedData: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      AppWalletSwapCircleExecutorService,
      'ensureTokenAllowance' | 'signTypedData'
    >
  >;
  let executor: AppWalletSwapStablefxExecutorService;
  const typedData = {
    domain: { verifyingContract: PERMIT2_ADDRESS },
    message: { spender: MESSAGE_SPENDER, witness: 'synthetic' },
  };
  const tradeInput = {
    amountIn: '17000000',
    approvalIdempotencyKey: 'approval-key',
    approvalRefId: 'APP-WALLET-SWAP-operation-STABLEFX-EURC-APPROVAL',
    chain: 'ARC-TESTNET',
    tokenIn: 'EURC' as const,
    tokenInAddress: TOKEN_ADDRESS,
    tokenOut: 'USDC' as const,
    tradeIdempotencyKey: 'trade-key',
    treasuryAddress: TREASURY_ADDRESS,
    treasuryWalletId: 'wallet-1',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    stablefxExecutionService.createTradableQuote.mockResolvedValue({
      id: 'quote-1',
      typedData,
      to: { currency: 'USDC', amount: '16' },
    });
    circleExecutor.ensureTokenAllowance.mockResolvedValue({
      allowanceBefore: '0',
      allowanceAfter: '17000000',
      approvalTxHash: SETTLEMENT_HASH,
    });
    circleExecutor.signTypedData.mockResolvedValue({
      signature: '0x1234',
      raw: { synthetic: true },
    });
    stablefxExecutionService.createTrade.mockResolvedValue({ id: 'trade-1' });
    stablefxExecutionService.createFundingPresign.mockResolvedValue({
      typedData,
    });
    stablefxExecutionService.fund.mockResolvedValue({ status: 'submitted' });
    stablefxExecutionService.getTrade.mockResolvedValue({
      id: 'trade-1',
      status: 'pending_settlement',
    });
    executor = new AppWalletSwapStablefxExecutorService(
      stablefxExecutionService as unknown as StablefxExecutionService,
      circleExecutor as unknown as AppWalletSwapCircleExecutorService,
    );
  });

  it('is registered in the App Wallet swap module', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppWalletSwapModule,
    );

    expect(providers).toContain(AppWalletSwapStablefxExecutorService);
  });

  it('creates a trade using the exact quote, allowance, signing, and trade inputs', async () => {
    const input = Object.freeze({ ...tradeInput });

    await expect(executor.createTradeExecution(input)).resolves.toEqual({
      approval: {
        allowanceAfter: '17000000',
        allowanceBefore: '0',
        approvalTarget: PERMIT2_ADDRESS,
        approvalTxHash: SETTLEMENT_HASH,
        messageSpender: MESSAGE_SPENDER,
        tokenAddress: TOKEN_ADDRESS,
        tokenIn: 'EURC',
        treasuryAddress: TREASURY_ADDRESS,
      },
      expectedOutput: '16000000',
      quote: expect.objectContaining({ id: 'quote-1' }),
      quoteId: 'quote-1',
      trade: { id: 'trade-1' },
      tradeId: 'trade-1',
    });
    expect(stablefxExecutionService.createTradableQuote).toHaveBeenCalledWith({
      amountIn: '17000000',
      chain: 'ARC-TESTNET',
      fromAddress: TREASURY_ADDRESS,
      recipientAddress: TREASURY_ADDRESS,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    expect(circleExecutor.ensureTokenAllowance).toHaveBeenCalledWith({
      approvalTarget: PERMIT2_ADDRESS,
      contractAddress: TOKEN_ADDRESS,
      idempotencyKey: 'approval-key',
      network: 'ARC-TESTNET',
      refId: 'APP-WALLET-SWAP-operation-STABLEFX-EURC-APPROVAL',
      requiredAllowance: 17000000n,
      treasuryAddress: TREASURY_ADDRESS,
      walletId: 'wallet-1',
    });
    expect(circleExecutor.signTypedData).toHaveBeenCalledWith({
      walletId: 'wallet-1',
      typedData,
      memo: 'WizPay App Wallet StableFX EURC->USDC quote',
    });
    expect(stablefxExecutionService.createTrade).toHaveBeenCalledWith({
      idempotencyKey: 'trade-key',
      quoteId: 'quote-1',
      address: TREASURY_ADDRESS,
      selectedAddress: TREASURY_ADDRESS,
      message: typedData.message,
      signature: '0x1234',
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      walletMode: 'app',
    });
    expect(input).toEqual(tradeInput);
  });

  it('calls each trade provider operation exactly once in order', async () => {
    await executor.createTradeExecution(tradeInput);

    expect(stablefxExecutionService.createTradableQuote).toHaveBeenCalledTimes(
      1,
    );
    expect(circleExecutor.ensureTokenAllowance).toHaveBeenCalledTimes(1);
    expect(circleExecutor.signTypedData).toHaveBeenCalledTimes(1);
    expect(stablefxExecutionService.createTrade).toHaveBeenCalledTimes(1);
    expect(
      stablefxExecutionService.createTradableQuote.mock.invocationCallOrder[0],
    ).toBeLessThan(
      circleExecutor.ensureTokenAllowance.mock.invocationCallOrder[0],
    );
    expect(
      circleExecutor.ensureTokenAllowance.mock.invocationCallOrder[0],
    ).toBeLessThan(circleExecutor.signTypedData.mock.invocationCallOrder[0]);
    expect(
      circleExecutor.signTypedData.mock.invocationCallOrder[0],
    ).toBeLessThan(
      stablefxExecutionService.createTrade.mock.invocationCallOrder[0],
    );
  });

  it('accepts the existing quoteId and nested tradeId response variants', async () => {
    stablefxExecutionService.createTradableQuote.mockResolvedValueOnce({
      quoteId: 42,
      typedData,
    });
    stablefxExecutionService.createTrade.mockResolvedValueOnce({
      data: { tradeId: 'nested-trade' },
    });

    await expect(
      executor.createTradeExecution(tradeInput),
    ).resolves.toMatchObject({
      quoteId: '42',
      tradeId: 'nested-trade',
      expectedOutput: null,
    });
  });

  it.each([
    ['quote', 'createTradableQuote'],
    ['approval', 'ensureTokenAllowance'],
    ['signing', 'signTypedData'],
    ['trade', 'createTrade'],
  ] as const)('propagates %s errors unchanged', async (_label, method) => {
    const error = new Error(`synthetic ${method} failure`);
    if (method === 'ensureTokenAllowance' || method === 'signTypedData') {
      circleExecutor[method].mockRejectedValueOnce(error);
    } else {
      stablefxExecutionService[method].mockRejectedValueOnce(error);
    }

    await expect(executor.createTradeExecution(tradeInput)).rejects.toBe(error);
  });

  it.each([
    [{ typedData }, 'quoteId and signable typedData'],
    [{ id: 'quote-1' }, 'quoteId and signable typedData'],
    [
      {
        id: 'quote-1',
        typedData: { domain: {}, message: {} },
      },
      'valid Permit2 verifyingContract',
    ],
  ])('rejects malformed quote response %#', async (quote, message) => {
    stablefxExecutionService.createTradableQuote.mockResolvedValueOnce(quote);

    await expect(executor.createTradeExecution(tradeInput)).rejects.toEqual(
      expect.objectContaining({
        name: 'AppWalletSwapStablefxResponseError',
        message: expect.stringContaining(message),
      }),
    );
  });

  it('rejects a trade response without an identifier', async () => {
    stablefxExecutionService.createTrade.mockResolvedValueOnce({
      status: 'new',
    });

    await expect(
      executor.createTradeExecution(tradeInput),
    ).rejects.toBeInstanceOf(AppWalletSwapStablefxResponseError);
  });

  it('prepares funding without submitting it', async () => {
    const input = Object.freeze({
      contractTradeId: '24',
      memo: 'WizPay App Wallet StableFX EURC->USDC funding',
      treasuryWalletId: 'wallet-1',
    });

    await expect(executor.prepareFunding(input)).resolves.toEqual({
      request: { permit2: typedData.message, signature: '0x1234' },
    });
    expect(stablefxExecutionService.createFundingPresign).toHaveBeenCalledWith({
      contractTradeId: '24',
    });
    expect(circleExecutor.signTypedData).toHaveBeenCalledWith({
      walletId: 'wallet-1',
      typedData,
      memo: input.memo,
    });
    expect(stablefxExecutionService.fund).not.toHaveBeenCalled();
    expect(input.contractTradeId).toBe('24');
  });

  it('rejects malformed funding presign data before signing or funding', async () => {
    stablefxExecutionService.createFundingPresign.mockResolvedValueOnce({});

    await expect(
      executor.prepareFunding({
        contractTradeId: '24',
        memo: 'synthetic',
        treasuryWalletId: 'wallet-1',
      }),
    ).rejects.toBeInstanceOf(AppWalletSwapStablefxResponseError);
    expect(circleExecutor.signTypedData).not.toHaveBeenCalled();
    expect(stablefxExecutionService.fund).not.toHaveBeenCalled();
  });

  it.each(['createFundingPresign', 'signTypedData'] as const)(
    'propagates %s funding-preparation errors unchanged',
    async (method) => {
      const error = new Error(`synthetic ${method} failure`);
      if (method === 'signTypedData') {
        circleExecutor.signTypedData.mockRejectedValueOnce(error);
      } else {
        stablefxExecutionService.createFundingPresign.mockRejectedValueOnce(
          error,
        );
      }

      await expect(
        executor.prepareFunding({
          contractTradeId: '24',
          memo: 'synthetic',
          treasuryWalletId: 'wallet-1',
        }),
      ).rejects.toBe(error);
    },
  );

  it('submits the exact funding payload without adding idempotency', async () => {
    const request = Object.freeze({
      permit2: Object.freeze({ witness: 'synthetic' }),
      signature: '0x1234',
    });
    const result = { status: 'submitted' };
    stablefxExecutionService.fund.mockResolvedValueOnce(result);

    await expect(executor.fundTrade(request)).resolves.toBe(result);
    expect(stablefxExecutionService.fund).toHaveBeenCalledWith(request);
    expect(stablefxExecutionService.fund.mock.calls[0][0]).not.toHaveProperty(
      'idempotencyKey',
    );
  });

  it('propagates funding submission errors unchanged', async () => {
    const error = new Error('synthetic funding failure');
    stablefxExecutionService.fund.mockRejectedValueOnce(error);

    await expect(
      executor.fundTrade({ permit2: {}, signature: '0x1234' }),
    ).rejects.toBe(error);
  });

  it('retrieves and interprets a trade exactly once', async () => {
    const raw = {
      id: 'trade-1',
      contractTradeId: '24',
      status: 'complete',
      to: { amount: '16' },
      contractTransactions: {
        makerDeliver: { status: 'success', txHash: SETTLEMENT_HASH },
      },
    };
    stablefxExecutionService.getTrade.mockResolvedValueOnce(raw);

    await expect(executor.getTradeState('trade-1')).resolves.toEqual({
      actualOutput: '16000000',
      contractTradeId: '24',
      isFailure: false,
      isSettlementComplete: true,
      makerDeliver: raw.contractTransactions.makerDeliver,
      makerDeliverStatus: 'success',
      raw,
      settlementHash: SETTLEMENT_HASH,
      status: 'complete',
    });
    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(1);
    expect(stablefxExecutionService.getTrade).toHaveBeenCalledWith('trade-1');
  });

  it.each(['complete', 'completed', 'settled'])(
    'accepts terminal success status %s when maker delivery is absent',
    (status) => {
      expect(executor.interpretTrade({ status }).isSettlementComplete).toBe(
        true,
      );
    },
  );

  it.each(['pending_settlement', 'taker_funded', 'maker_funded', 'unknown'])(
    'keeps provider status %s pending',
    (status) => {
      const state = executor.interpretTrade({ status });
      expect(state.isFailure).toBe(false);
      expect(state.isSettlementComplete).toBe(false);
    },
  );

  it.each(['failed', 'rejected', 'expired', 'breached', 'refunded', 'FAILED'])(
    'recognizes provider status %s as terminal failure',
    (status) => {
      expect(executor.interpretTrade({ status }).isFailure).toBe(true);
    },
  );

  it('requires successful maker delivery when maker delivery exists', () => {
    const pending = executor.interpretTrade({
      status: 'complete',
      contractTransactions: { makerDeliver: { status: 'pending' } },
    });
    const missingStatus = executor.interpretTrade({
      status: 'complete',
      contractTransactions: { makerDeliver: {} },
    });

    expect(pending.isSettlementComplete).toBe(false);
    expect(missingStatus.isSettlementComplete).toBe(false);
  });

  it('preserves nested provider response traversal and six-decimal output', () => {
    expect(
      executor.interpretTrade({
        data: {
          status: 'settled',
          contractTradeId: 'nested-24',
          to: { amount: '16.123456' },
          contractTransactions: {
            makerDeliver: { status: 'success', txHash: SETTLEMENT_HASH },
          },
        },
      }),
    ).toMatchObject({
      actualOutput: '16123456',
      contractTradeId: 'nested-24',
      isSettlementComplete: true,
      settlementHash: SETTLEMENT_HASH,
      status: 'settled',
    });
  });

  it('prefers the accepted top-level settlement hash source', () => {
    expect(
      executor.extractSettlementHash({
        settlementTransactionHash: SETTLEMENT_HASH,
        contractTransactions: {
          makerDeliver: { status: 'success', txHash: INTERMEDIATE_HASH },
        },
      }),
    ).toBe(SETTLEMENT_HASH);
  });

  it('never accepts taker delivery or unrelated intermediate hashes', () => {
    expect(
      executor.extractSettlementHash({
        transactionHash: INTERMEDIATE_HASH,
        contractTransactions: {
          takerDeliver: { status: 'success', txHash: INTERMEDIATE_HASH },
        },
      }),
    ).toBeNull();
  });

  it('preserves missing optional fields as unknown and null', () => {
    expect(executor.interpretTrade({})).toEqual({
      actualOutput: null,
      contractTradeId: null,
      isFailure: false,
      isSettlementComplete: false,
      makerDeliver: null,
      makerDeliverStatus: null,
      raw: {},
      settlementHash: null,
      status: 'unknown',
    });
  });

  it('propagates trade retrieval errors unchanged', async () => {
    const error = new Error('synthetic polling failure');
    stablefxExecutionService.getTrade.mockRejectedValueOnce(error);

    await expect(executor.getTradeState('trade-1')).rejects.toBe(error);
  });
});

describe('AppWalletSwapStablefxExecutorService App Wallet stage orchestration', () => {
  const stablefxExecutionService = {
    createTradableQuote: jest.fn(),
    createTrade: jest.fn(),
    createFundingPresign: jest.fn(),
    fund: jest.fn(),
    getTrade: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      StablefxExecutionService,
      | 'createTradableQuote'
      | 'createTrade'
      | 'createFundingPresign'
      | 'fund'
      | 'getTrade'
    >
  >;
  const circleExecutor = {
    ensureTokenAllowance: jest.fn(),
    signTypedData: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      AppWalletSwapCircleExecutorService,
      'ensureTokenAllowance' | 'signTypedData'
    >
  >;
  let operation: AppWalletSwapOperation;
  let repository: jest.Mocked<Pick<AppWalletSwapOperationRepository, 'update'>>;
  let executor: AppWalletSwapStablefxExecutorService;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CIRCLE_WALLET_ADDRESS_ARC = TREASURY_ADDRESS;
    process.env.CIRCLE_WALLET_ID_ARC = 'wallet-1';
    delete process.env.APP_WALLET_SWAP_POLL_TIMEOUT_MS;
    delete process.env.APP_WALLET_PROVIDER_TIMEOUT_MS;
    operation = createOperation();
    repository = {
      update: jest.fn(async (_operationId, data) => {
        operation = { ...operation, ...data } as AppWalletSwapOperation;
        return operation;
      }),
    };
    stablefxExecutionService.createTradableQuote.mockResolvedValue({
      id: 'quote-1',
      typedData: {
        domain: { verifyingContract: PERMIT2_ADDRESS },
        message: { spender: MESSAGE_SPENDER },
      },
      to: { currency: 'USDC', amount: '16' },
    });
    stablefxExecutionService.createTrade.mockResolvedValue({ id: 'trade-1' });
    stablefxExecutionService.createFundingPresign.mockResolvedValue({
      typedData: {
        domain: { verifyingContract: PERMIT2_ADDRESS },
        message: { spender: MESSAGE_SPENDER },
      },
    });
    stablefxExecutionService.fund.mockResolvedValue({ status: 'submitted' });
    stablefxExecutionService.getTrade.mockResolvedValue({
      id: 'trade-1',
      status: 'pending_settlement',
    });
    circleExecutor.ensureTokenAllowance.mockResolvedValue({
      allowanceBefore: '17000000',
      allowanceAfter: '17000000',
    });
    circleExecutor.signTypedData.mockResolvedValue({
      signature: '0x1234',
      raw: { synthetic: true },
    });
    executor = new AppWalletSwapStablefxExecutorService(
      stablefxExecutionService as unknown as StablefxExecutionService,
      circleExecutor as unknown as AppWalletSwapCircleExecutorService,
      repository as AppWalletSwapOperationRepository,
    );
  });

  function response(): AppWalletSwapOperationResponse {
    return mapAppWalletSwapOperationRecord(operation);
  }

  function completeTrade() {
    stablefxExecutionService.getTrade
      .mockResolvedValueOnce({
        id: 'trade-1',
        contractTradeId: '24',
        status: 'pending_settlement',
      })
      .mockResolvedValueOnce({
        id: 'trade-1',
        contractTradeId: '24',
        status: 'complete',
        to: { currency: 'USDC', amount: '16' },
        contractTransactions: {
          makerDeliver: { status: 'success', txHash: SETTLEMENT_HASH },
        },
      });
  }

  it('creates, funds, and confirms a fresh trade with exactly two GETs', async () => {
    completeTrade();

    const created = await executor.submitTreasurySwapIfNeeded(response());
    const confirmed = await executor.confirmTreasurySwapIfPossible(created);

    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(2);
    expect(confirmed).toMatchObject({
      status: 'treasury_swap_confirmed',
      treasurySwapId: 'trade-1',
      treasurySwapActualOutput: '16000000',
      treasurySwapTxHash: SETTLEMENT_HASH,
    });
  });

  it('keeps the first GET before funding and the second GET after funded-state persistence', async () => {
    completeTrade();

    const created = await executor.submitTreasurySwapIfNeeded(response());
    await executor.confirmTreasurySwapIfPossible(created);

    expect(
      stablefxExecutionService.getTrade.mock.invocationCallOrder[0],
    ).toBeLessThan(
      stablefxExecutionService.createFundingPresign.mock.invocationCallOrder[0],
    );
    expect(
      stablefxExecutionService.createFundingPresign.mock.invocationCallOrder[0],
    ).toBeLessThan(stablefxExecutionService.fund.mock.invocationCallOrder[0]);
    const fundedWrite = repository.update.mock.calls.findIndex(
      ([, data]) => data.status === 'stablefx_funded',
    );
    expect(
      repository.update.mock.invocationCallOrder[fundedWrite],
    ).toBeLessThan(
      stablefxExecutionService.getTrade.mock.invocationCallOrder[1],
    );
  });

  it('preserves the exact fresh repository status-write sequence', async () => {
    completeTrade();

    const created = await executor.submitTreasurySwapIfNeeded(response());
    await executor.confirmTreasurySwapIfPossible(created);

    expect(
      repository.update.mock.calls
        .map(([, data]) => data.status)
        .filter((status): status is string => typeof status === 'string'),
    ).toEqual([
      'stablefx_quote_requested',
      'stablefx_trade_created',
      'stablefx_contract_ready',
      'stablefx_funded',
      'treasury_swap_confirmed',
    ]);
    expect(
      repository.update.mock.calls.some(([, data]) =>
        Boolean(data.stablefxFundingRequestedAt),
      ),
    ).toBe(true);
    expect(
      repository.update.mock.calls.some(([, data]) =>
        Boolean(data.stablefxFundedAt),
      ),
    ).toBe(true);
  });

  it('uses depositConfirmedAmount and preserves six-decimal base units', async () => {
    operation = createOperation({
      amountIn: '99999999',
      depositConfirmedAmount: '17000000',
    });
    completeTrade();

    const created = await executor.submitTreasurySwapIfNeeded(response());

    expect(stablefxExecutionService.createTradableQuote).toHaveBeenCalledWith(
      expect.objectContaining({ amountIn: '17000000' }),
    );
    expect(created.treasurySwapExpectedOutput).toBe('16000000');
  });

  it('does not create a replacement trade when treasurySwapId already exists', async () => {
    operation = createOperation({
      status: 'stablefx_trade_created',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
    });

    const result = await executor.submitTreasurySwapIfNeeded(response());

    expect(result.treasurySwapId).toBe('existing-trade');
    expect(stablefxExecutionService.createTradableQuote).not.toHaveBeenCalled();
    expect(stablefxExecutionService.createTrade).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('resumes a funded operation with exactly one GET and no funding calls', async () => {
    operation = createOperation({
      status: 'stablefx_funded',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
      stablefxFundingRequestedAt: SUBMITTED_AT,
      stablefxFundedAt: SUBMITTED_AT,
    });
    stablefxExecutionService.getTrade.mockResolvedValueOnce({
      id: 'existing-trade',
      status: 'pending_settlement',
    });

    const result = await executor.confirmTreasurySwapIfPossible(response());

    expect(result.status).toBe('stablefx_funded');
    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(1);
    expect(
      stablefxExecutionService.createFundingPresign,
    ).not.toHaveBeenCalled();
    expect(stablefxExecutionService.fund).not.toHaveBeenCalled();
  });

  it('resumes a contract-ready operation with its existing marker using one GET', async () => {
    operation = createOperation({
      status: 'stablefx_contract_ready',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
      stablefxFundingRequestedAt: SUBMITTED_AT,
    });
    stablefxExecutionService.getTrade.mockResolvedValueOnce({
      id: 'existing-trade',
      status: 'pending_settlement',
    });

    await executor.confirmTreasurySwapIfPossible(response());

    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(1);
    expect(stablefxExecutionService.fund).not.toHaveBeenCalled();
  });

  it('keeps a contract-ready operation without a funding marker on the characterized two-GET path', async () => {
    operation = createOperation({
      status: 'stablefx_contract_ready',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
    });
    completeTrade();

    await executor.confirmTreasurySwapIfPossible(response());

    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(2);
    expect(stablefxExecutionService.createFundingPresign).toHaveBeenCalledTimes(
      1,
    );
    expect(stablefxExecutionService.fund).toHaveBeenCalledTimes(1);
  });

  it('does not add a GET when the operation is already confirmed', async () => {
    operation = createOperation({
      status: 'treasury_swap_confirmed',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
      treasurySwapConfirmedAt: SUBMITTED_AT,
      treasurySwapActualOutput: '16000000',
    });

    const result = await executor.confirmTreasurySwapIfPossible(response());

    expect(result.status).toBe('treasury_swap_confirmed');
    expect(stablefxExecutionService.getTrade).not.toHaveBeenCalled();
  });

  it('preserves a pending post-funding state with one GET and one snapshot write', async () => {
    operation = createOperation({
      status: 'stablefx_funded',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
      stablefxFundingRequestedAt: SUBMITTED_AT,
      stablefxFundedAt: SUBMITTED_AT,
    });
    stablefxExecutionService.getTrade.mockResolvedValueOnce({
      id: 'existing-trade',
      status: 'maker_funded',
    });

    const result = await executor.confirmTreasurySwapIfPossible(response());

    expect(result.status).toBe('stablefx_funded');
    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(repository.update.mock.calls[0][1].rawTreasurySwap).toBeDefined();
  });

  it('preserves terminal provider failure without another provider call', async () => {
    operation = createOperation({
      status: 'stablefx_funded',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
      stablefxFundingRequestedAt: SUBMITTED_AT,
      stablefxFundedAt: SUBMITTED_AT,
    });
    stablefxExecutionService.getTrade.mockResolvedValueOnce({
      id: 'existing-trade',
      status: 'failed',
    });

    await expect(
      executor.confirmTreasurySwapIfPossible(response()),
    ).rejects.toMatchObject({
      message: 'StableFX Treasury trade failed with status failed.',
    });
    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(1);
    expect(
      stablefxExecutionService.createFundingPresign,
    ).not.toHaveBeenCalled();
  });

  it('fails before polling when the persisted polling deadline has elapsed', async () => {
    process.env.APP_WALLET_SWAP_POLL_TIMEOUT_MS = '1';
    operation = createOperation({
      status: 'stablefx_funded',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: new Date(Date.now() - 1000),
      stablefxFundingRequestedAt: SUBMITTED_AT,
      stablefxFundedAt: SUBMITTED_AT,
    });

    await expect(
      executor.confirmTreasurySwapIfPossible(response()),
    ).rejects.toMatchObject({
      message:
        'StableFX execution polling timed out. The operation requires recovery or a verified refund.',
    });
    expect(stablefxExecutionService.getTrade).not.toHaveBeenCalled();
  });

  it('preserves malformed trade responses as pending without extra polling', async () => {
    operation = createOperation({
      status: 'stablefx_funded',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
      stablefxFundingRequestedAt: SUBMITTED_AT,
      stablefxFundedAt: SUBMITTED_AT,
    });
    stablefxExecutionService.getTrade.mockResolvedValueOnce({});

    const result = await executor.confirmTreasurySwapIfPossible(response());

    expect(result.status).toBe('stablefx_funded');
    expect(stablefxExecutionService.getTrade).toHaveBeenCalledTimes(1);
  });

  it('preserves the source operation while mapping persistence results', async () => {
    const source = createOperation();
    operation = source;
    const before = structuredClone(source);
    completeTrade();

    await executor.submitTreasurySwapIfNeeded(response());

    expect(source).toEqual(before);
  });

  it('sanitizes provider payloads before storing funding snapshots', async () => {
    operation = createOperation({
      status: 'stablefx_contract_ready',
      treasurySwapId: 'existing-trade',
      treasurySwapSubmittedAt: SUBMITTED_AT,
    });
    completeTrade();
    stablefxExecutionService.fund.mockResolvedValueOnce({
      status: 'submitted',
      apiKey: 'secret-api-key',
      signature: 'secret-signature',
    });

    await executor.confirmTreasurySwapIfPossible(response());

    const serialized = JSON.stringify(
      repository.update.mock.calls.find(
        ([, data]) => data.status === 'stablefx_funded',
      )?.[1].rawTreasurySwap,
    );
    expect(serialized).not.toContain('secret-api-key');
    expect(serialized).not.toContain('secret-signature');
  });

  it('fails closed for a missing persisted provider before provider or persistence calls', async () => {
    operation = createOperation({ executionProvider: null });

    await expect(
      executor.submitTreasurySwapIfNeeded(response()),
    ).rejects.toMatchObject({
      response: { code: 'APP_WALLET_SWAP_EXECUTION_PROVIDER_INVALID' },
    });
    expect(stablefxExecutionService.createTradableQuote).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('does not process a persisted SwapKit operation', async () => {
    operation = createOperation({ executionProvider: 'swapkit' });

    const result = await executor.submitTreasurySwapIfNeeded(response());

    expect(result.provider).toBe('swapkit');
    expect(stablefxExecutionService.createTradableQuote).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });
});
