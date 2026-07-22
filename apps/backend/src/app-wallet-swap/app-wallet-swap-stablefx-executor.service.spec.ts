import { MODULE_METADATA } from '@nestjs/common/constants';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapModule } from './app-wallet-swap.module';
import {
  AppWalletSwapStablefxExecutorService,
  AppWalletSwapStablefxResponseError,
} from './app-wallet-swap-stablefx-executor.service';

const TREASURY_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_ADDRESS = '0xcccccccccccccccccccccccccccccccccccccccc';
const PERMIT2_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MESSAGE_SPENDER = '0xdddddddddddddddddddddddddddddddddddddddd';
const SETTLEMENT_HASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111';
const INTERMEDIATE_HASH =
  '0x2222222222222222222222222222222222222222222222222222222222222222';

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
