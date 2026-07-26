import { BadRequestException } from '@nestjs/common';
import { AppWalletSwapOperation } from '@prisma/client';
import { createHash } from 'crypto';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapDepositService } from './app-wallet-swap-deposit.service';
import { AppWalletSwapOperationRepository } from './app-wallet-swap-operation.repository';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import { AppWalletSwapRefundService } from './app-wallet-swap-refund.service';
import { AppWalletSwapService } from './app-wallet-swap.service';
import {
  AppWalletSwapStablefxExecutorService,
  AppWalletSwapStablefxTradeState,
} from './app-wallet-swap-stablefx-executor.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import {
  APP_WALLET_SWAP_CHAIN,
  AppWalletSwapOperationStatus,
} from './app-wallet-swap.types';
import {
  USER_SWAP_USDC_ADDRESS,
  UserSwapService,
} from '../user-swap/user-swap.service';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ADDRESS = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const TREASURY_ADDRESS = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b';
const REFUND_TX_HASH =
  '0xaa019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
const CREATED_AT = new Date('2099-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2099-01-01T00:00:10.000Z');

function createRecord(
  overrides: Partial<AppWalletSwapOperation> = {},
): AppWalletSwapOperation {
  return {
    operationId: OPERATION_ID,
    operationMode: 'treasury-mediated',
    sourceChain: APP_WALLET_SWAP_CHAIN,
    tokenIn: 'USDC',
    tokenOut: 'EURC',
    amountIn: '1000000',
    userWalletAddress: USER_ADDRESS,
    treasuryDepositAddress: TREASURY_ADDRESS,
    expectedOutput: '990000',
    minimumOutput: '970000',
    expiresAt: '2099-01-01T00:05:00.000Z',
    status: 'execution_recovery_required',
    executionProvider: 'swapkit',
    quoteId: 'quote-1',
    rawQuote: { provider: 'swapkit' },
    depositTxHash: null,
    circleTransactionId: 'deposit-transaction-1',
    circleReferenceId: 'app-wallet-swap-deposit-1',
    circleWalletId: 'user-wallet-1',
    depositSubmittedAt: new Date('2099-01-01T00:00:05.000Z'),
    depositConfirmedAt: new Date('2099-01-01T00:00:08.000Z'),
    depositConfirmedAmount: '1000000',
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
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  } as AppWalletSwapOperation;
}

function deriveExpectedIdempotencyKey(
  operationId: string,
  purpose: string,
): string {
  const hex = createHash('sha256')
    .update(`${operationId}:${purpose}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function failedTrade(
  overrides: Partial<AppWalletSwapStablefxTradeState> = {},
): AppWalletSwapStablefxTradeState {
  return {
    actualOutput: null,
    contractTradeId: 'trade-1',
    isFailure: true,
    isSettlementComplete: false,
    makerDeliver: null,
    makerDeliverStatus: null,
    raw: { status: 'failed' },
    settlementHash: null,
    status: 'failed',
    ...overrides,
  };
}

describe('AppWalletSwapRefundService', () => {
  const originalEnv = process.env;
  let record: AppWalletSwapOperation | null;
  let repository: jest.Mocked<
    Pick<
      AppWalletSwapOperationRepository,
      'claimExecutionLease' | 'findById' | 'releaseExecutionLease' | 'update'
    >
  >;
  let circleExecutor: jest.Mocked<
    Pick<
      AppWalletSwapCircleExecutorService,
      | 'formatBaseUnits'
      | 'getTransactionStatus'
      | 'getWalletBalance'
      | 'getW3sTransaction'
      | 'listW3sTransactions'
      | 'submitTransfer'
    >
  >;
  let stablefxExecutor: jest.Mocked<
    Pick<AppWalletSwapStablefxExecutorService, 'getTradeState'>
  >;
  let treasuryVerifier: jest.Mocked<
    Pick<AppWalletSwapTreasuryVerifierService, 'verifyPayout'>
  >;
  let service: AppWalletSwapRefundService;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      CIRCLE_WALLET_ID_ARC: 'treasury-wallet-1',
    };
    delete process.env.APP_WALLET_PROVIDER_TIMEOUT_MS;
    record = createRecord();
    repository = {
      claimExecutionLease: jest.fn().mockResolvedValue(true),
      findById: jest.fn(async (operationId) =>
        record?.operationId === operationId ? record : null,
      ),
      releaseExecutionLease: jest.fn().mockResolvedValue(undefined),
      update: jest.fn(async (operationId, data) => {
        if (!record || record.operationId !== operationId) {
          throw new Error('Record not found');
        }

        record = { ...record, ...data } as AppWalletSwapOperation;
        return record;
      }),
    };
    circleExecutor = {
      formatBaseUnits: jest.fn().mockReturnValue('1'),
      getTransactionStatus: jest.fn().mockResolvedValue({
        txId: 'refund-transaction-1',
        status: 'COMPLETE',
        txHash: REFUND_TX_HASH,
        blockNumber: '1',
        errorReason: null,
      }),
      getWalletBalance: jest.fn().mockResolvedValue([
        {
          amount: '1',
          tokenAddress: USER_SWAP_USDC_ADDRESS,
        },
      ]),
      getW3sTransaction: jest.fn(),
      listW3sTransactions: jest.fn(),
      submitTransfer: jest.fn().mockResolvedValue({
        txId: 'refund-transaction-1',
        status: 'COMPLETE',
        txHash: REFUND_TX_HASH,
      }),
    };
    stablefxExecutor = {
      getTradeState: jest.fn().mockResolvedValue(failedTrade()),
    };
    treasuryVerifier = {
      verifyPayout: jest.fn().mockResolvedValue({ confirmed: true }),
    };
    service = new AppWalletSwapRefundService(
      treasuryVerifier as AppWalletSwapTreasuryVerifierService,
      circleExecutor as AppWalletSwapCircleExecutorService,
      stablefxExecutor as AppWalletSwapStablefxExecutorService,
      repository as AppWalletSwapOperationRepository,
    );
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('claims a 15-minute database-backed lease before refund work', async () => {
    await service.recover(OPERATION_ID);

    const [, leaseId, claimedAt, expiresAt] =
      repository.claimExecutionLease.mock.calls[0];
    expect(leaseId).toEqual(expect.any(String));
    expect(expiresAt.getTime() - claimedAt.getTime()).toBe(15 * 60 * 1000);
    expect(
      repository.claimExecutionLease.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.findById.mock.invocationCallOrder[0]);
  });

  it('returns current public state without financial side effects on lease contention', async () => {
    repository.claimExecutionLease.mockResolvedValue(false);

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('execution_recovery_required');
    expect(circleExecutor.getWalletBalance).not.toHaveBeenCalled();
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
    expect(treasuryVerifier.verifyPayout).not.toHaveBeenCalled();
    expect(repository.releaseExecutionLease).not.toHaveBeenCalled();
  });

  it('releases only the lease owner after successful recovery', async () => {
    await service.recover(OPERATION_ID);

    const claimedLeaseId = repository.claimExecutionLease.mock.calls[0][1];
    expect(repository.releaseExecutionLease).toHaveBeenCalledWith(
      OPERATION_ID,
      claimedLeaseId,
    );
  });

  it('releases only the lease owner after a refund-stage failure', async () => {
    circleExecutor.getWalletBalance.mockRejectedValue(
      new Error('balance down'),
    );

    await service.recover(OPERATION_ID);

    const claimedLeaseId = repository.claimExecutionLease.mock.calls[0][1];
    expect(repository.releaseExecutionLease).toHaveBeenCalledWith(
      OPERATION_ID,
      claimedLeaseId,
    );
  });

  it('persists refund intent before calling Circle transfer', async () => {
    await service.recover(OPERATION_ID);

    const intentCall = repository.update.mock.calls.findIndex(
      ([, data]) => data.status === 'refund_pending',
    );
    expect(intentCall).toBeGreaterThanOrEqual(0);
    expect(repository.update.mock.invocationCallOrder[intentCall]).toBeLessThan(
      circleExecutor.submitTransfer.mock.invocationCallOrder[0],
    );
  });

  it('uses depositConfirmedAmount as the refund amount source', async () => {
    record = createRecord({
      amountIn: '9000000',
      depositConfirmedAmount: '1250000',
    });
    circleExecutor.getWalletBalance.mockResolvedValue([
      { amount: '1.25', tokenAddress: USER_SWAP_USDC_ADDRESS },
    ]);
    circleExecutor.formatBaseUnits.mockReturnValue('1.25');

    await service.recover(OPERATION_ID);

    expect(circleExecutor.submitTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '1.25' }),
    );
    expect(repository.update).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ refundAmount: '1250000' }),
    );
  });

  it('fails closed when the verified deposit amount is missing', async () => {
    record = createRecord({ depositConfirmedAmount: null });

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('execution_recovery_required');
    expect(result.executionError).toContain('verified deposit amount');
    expect(circleExecutor.getWalletBalance).not.toHaveBeenCalled();
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it.each([
    ['treasury swap confirmation', { treasurySwapConfirmedAt: UPDATED_AT }],
    ['payout submission', { payoutSubmittedAt: UPDATED_AT }],
  ])('blocks refund after %s', async (_name, overrides) => {
    record = createRecord(overrides);

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('execution_recovery_required');
    expect(result.executionError).toContain('settlement/payout');
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it('fails closed before transfer when treasury balance is insufficient', async () => {
    circleExecutor.getWalletBalance.mockResolvedValue([
      { amount: '0.999999', tokenAddress: USER_SWAP_USDC_ADDRESS },
    ]);

    const result = await service.recover(OPERATION_ID);

    expect(result.executionError).toContain('treasury does not hold');
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it('matches the treasury token address case-insensitively', async () => {
    circleExecutor.getWalletBalance.mockResolvedValue([
      {
        amount: '1',
        tokenAddress: USER_SWAP_USDC_ADDRESS.toUpperCase(),
      },
    ]);

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('refunded');
  });

  it('fails closed when no matching treasury token balance exists', async () => {
    circleExecutor.getWalletBalance.mockResolvedValue([
      {
        amount: '100',
        tokenAddress: '0x1111111111111111111111111111111111111111',
      },
    ]);

    const result = await service.recover(OPERATION_ID);

    expect(result.executionError).toContain('treasury does not hold');
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it('uses the deterministic deposit-refund idempotency key', async () => {
    await service.recover(OPERATION_ID);

    expect(circleExecutor.submitTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: deriveExpectedIdempotencyKey(
          OPERATION_ID,
          'deposit-refund',
        ),
      }),
    );
  });

  it('preserves the Circle refund transfer contract', async () => {
    await service.recover(OPERATION_ID);

    expect(circleExecutor.submitTransfer).toHaveBeenCalledWith({
      walletId: 'treasury-wallet-1',
      network: APP_WALLET_SWAP_CHAIN,
      token: 'USDC',
      toAddress: USER_ADDRESS,
      amount: '1',
      idempotencyKey: expect.any(String),
    });
  });

  it('persists the Circle transaction ID and valid hash before confirmation', async () => {
    await service.recover(OPERATION_ID);

    expect(repository.update).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({
        status: 'refund_submitted',
        refundTransactionId: 'refund-transaction-1',
        refundTxHash: REFUND_TX_HASH,
        refundSubmittedAt: expect.any(Date),
      }),
    );
  });

  it('does not persist an invalid provider transaction hash', async () => {
    circleExecutor.submitTransfer.mockResolvedValue({
      txId: 'refund-transaction-1',
      status: 'QUEUED',
      txHash: '0x1234',
    });
    circleExecutor.getTransactionStatus.mockResolvedValue({
      txId: 'refund-transaction-1',
      status: 'QUEUED',
      txHash: null,
      blockNumber: null,
      errorReason: null,
    });

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('refund_submitted');
    expect(result.refundTxHash).toBeUndefined();
  });

  it('sanitizes secrets and signatures from persisted raw refund snapshots', async () => {
    const providerPayload = {
      txId: 'refund-transaction-1',
      status: 'COMPLETE',
      txHash: REFUND_TX_HASH,
      apiKey: 'secret-api-key',
      signature: 'secret-signature',
      nested: { authorization: 'secret-authorization' },
    };
    const providerPayloadBefore = structuredClone(providerPayload);
    circleExecutor.submitTransfer.mockResolvedValue(providerPayload as never);

    await service.recover(OPERATION_ID);

    const submittedWrite = repository.update.mock.calls.find(
      ([, data]) => data.status === 'refund_submitted',
    )?.[1];
    const serialized = JSON.stringify(submittedWrite?.rawRefund);
    expect(serialized).not.toContain('secret-api-key');
    expect(serialized).not.toContain('secret-signature');
    expect(serialized).not.toContain('secret-authorization');
    expect(providerPayload).toEqual(providerPayloadBefore);
  });

  it('keeps a queued Circle refund retryable without resubmitting', async () => {
    circleExecutor.submitTransfer.mockResolvedValue({
      txId: 'refund-transaction-1',
      status: 'QUEUED',
      txHash: null,
    });
    circleExecutor.getTransactionStatus.mockResolvedValue({
      txId: 'refund-transaction-1',
      status: 'QUEUED',
      txHash: null,
      blockNumber: null,
      errorReason: null,
    });

    const first = await service.recover(OPERATION_ID);
    const second = await service.recover(OPERATION_ID);

    expect(first.status).toBe('refund_submitted');
    expect(second.status).toBe('refund_submitted');
    expect(circleExecutor.submitTransfer).toHaveBeenCalledTimes(1);
    expect(circleExecutor.getTransactionStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['FAILED', 'CANCELLED', 'DENIED'] as const)(
    'maps Circle %s to recovery-required without a second transfer',
    async (status) => {
      record = createRecord({
        status: 'refund_submitted',
        refundAmount: '1000000',
        refundTransactionId: 'refund-transaction-1',
        refundSubmittedAt: UPDATED_AT,
      });
      circleExecutor.getTransactionStatus.mockResolvedValue({
        txId: 'refund-transaction-1',
        status,
        txHash: null,
        blockNumber: null,
        errorReason: 'provider rejected transaction',
      });

      const result = await service.recover(OPERATION_ID);

      expect(result.status).toBe('execution_recovery_required');
      expect(result.executionError).toContain(status);
      expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
    },
  );

  it('confirms a submitted refund only after on-chain payout verification', async () => {
    record = createRecord({
      status: 'refund_submitted',
      refundAmount: '1000000',
      refundTransactionId: 'refund-transaction-1',
      refundTxHash: REFUND_TX_HASH,
      refundSubmittedAt: UPDATED_AT,
    });

    const result = await service.recover(OPERATION_ID);

    expect(treasuryVerifier.verifyPayout).toHaveBeenCalledWith({
      tokenOut: 'USDC',
      txHash: REFUND_TX_HASH,
      treasuryAddress: TREASURY_ADDRESS,
      userWalletAddress: USER_ADDRESS,
      payoutAmount: '1000000',
    });
    expect(result.status).toBe('refunded');
    expect(result.refundConfirmedAt).toEqual(expect.any(String));
  });

  it('keeps an unverified on-chain refund submitted', async () => {
    record = createRecord({
      status: 'refund_submitted',
      refundAmount: '1000000',
      refundTransactionId: 'refund-transaction-1',
      refundTxHash: REFUND_TX_HASH,
      refundSubmittedAt: UPDATED_AT,
    });
    treasuryVerifier.verifyPayout.mockResolvedValue({
      confirmed: false,
      error: 'receipt pending',
    });

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('refund_submitted');
    expect(result.refundConfirmedAt).toBeUndefined();
  });

  it('resumes from a persisted refund transaction ID without a replacement transfer', async () => {
    record = createRecord({
      status: 'refund_submitted',
      refundAmount: '1000000',
      refundTransactionId: 'refund-transaction-existing',
      refundSubmittedAt: UPDATED_AT,
    });
    circleExecutor.getTransactionStatus.mockResolvedValue({
      txId: 'refund-transaction-existing',
      status: 'COMPLETE',
      txHash: REFUND_TX_HASH,
      blockNumber: '1',
      errorReason: null,
    });

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('refunded');
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
    expect(circleExecutor.getTransactionStatus).toHaveBeenCalledWith(
      'refund-transaction-existing',
    );
  });

  it('retries a refund_pending crash boundary with the same idempotency key', async () => {
    record = createRecord({
      status: 'refund_pending',
      refundAmount: '1000000',
    });

    await service.recover(OPERATION_ID);

    expect(circleExecutor.submitTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: deriveExpectedIdempotencyKey(
          OPERATION_ID,
          'deposit-refund',
        ),
      }),
    );
  });

  it('does not transfer or verify an already-refunded stage record', async () => {
    record = createRecord({
      status: 'refunded',
      refundAmount: '1000000',
      refundTransactionId: 'refund-transaction-1',
      refundTxHash: REFUND_TX_HASH,
      refundSubmittedAt: UPDATED_AT,
      refundConfirmedAt: UPDATED_AT,
    });

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('refunded');
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
    expect(treasuryVerifier.verifyPayout).not.toHaveBeenCalled();
  });

  it('blocks a funded StableFX refund until the trade is terminally failed', async () => {
    record = createRecord({
      executionProvider: 'stablefx',
      treasurySwapId: 'trade-1',
      stablefxFundingRequestedAt: UPDATED_AT,
    });
    stablefxExecutor.getTradeState.mockResolvedValue(
      failedTrade({ isFailure: false, status: 'pending' }),
    );

    const result = await service.recover(OPERATION_ID);

    expect(stablefxExecutor.getTradeState).toHaveBeenCalledWith('trade-1');
    expect(result.executionError).toContain('not in a terminal failure');
    expect(circleExecutor.getWalletBalance).not.toHaveBeenCalled();
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it('allows a funded StableFX refund after a terminal failure', async () => {
    record = createRecord({
      executionProvider: 'stablefx',
      treasurySwapId: 'trade-1',
      stablefxFundingRequestedAt: UPDATED_AT,
    });

    const result = await service.recover(OPERATION_ID);

    expect(stablefxExecutor.getTradeState).toHaveBeenCalledWith('trade-1');
    expect(result.status).toBe('refunded');
  });

  it('blocks funded StableFX recovery without a persisted trade ID', async () => {
    record = createRecord({
      executionProvider: 'stablefx',
      stablefxFundingRequestedAt: UPDATED_AT,
      treasurySwapId: null,
    });

    const result = await service.recover(OPERATION_ID);

    expect(result.executionError).toContain('without a recoverable trade');
    expect(stablefxExecutor.getTradeState).not.toHaveBeenCalled();
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it('recognizes persisted nested StableFX funding evidence', async () => {
    record = createRecord({
      executionProvider: 'stablefx',
      treasurySwapId: 'trade-1',
      rawTreasurySwap: {
        previous: { funding: { fund: { status: 'submitted' } } },
      },
    });

    await service.recover(OPERATION_ID);

    expect(stablefxExecutor.getTradeState).toHaveBeenCalledWith('trade-1');
  });

  it('does not poll StableFX for a persisted SwapKit operation', async () => {
    record = createRecord({
      executionProvider: 'swapkit',
      treasurySwapId: 'swapkit-transaction-1',
      stablefxFundingRequestedAt: UPDATED_AT,
      rawTreasurySwap: { fund: { status: 'submitted' } },
    });

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('refunded');
    expect(stablefxExecutor.getTradeState).not.toHaveBeenCalled();
  });

  it('uses direct Circle transaction polling and never a W3S list fallback', async () => {
    record = createRecord({
      status: 'refund_submitted',
      refundAmount: '1000000',
      refundTransactionId: 'refund-transaction-1',
      refundSubmittedAt: UPDATED_AT,
    });
    circleExecutor.getTransactionStatus.mockResolvedValue({
      txId: 'refund-transaction-1',
      status: 'QUEUED',
      txHash: null,
      blockNumber: null,
      errorReason: null,
    });

    await service.recover(OPERATION_ID);

    expect(circleExecutor.getTransactionStatus).toHaveBeenCalledTimes(1);
    expect(circleExecutor.getW3sTransaction).not.toHaveBeenCalled();
    expect(circleExecutor.listW3sTransactions).not.toHaveBeenCalled();
  });

  it('tolerates a partial Circle status payload without broadening recovery', async () => {
    record = createRecord({
      status: 'refund_submitted',
      refundAmount: '1000000',
      refundTransactionId: 'refund-transaction-1',
      refundSubmittedAt: UPDATED_AT,
    });
    circleExecutor.getTransactionStatus.mockResolvedValue({
      txId: 'refund-transaction-1',
      status: 'QUEUED',
    } as never);

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('refund_submitted');
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it('does not mutate the source record supplied by the repository', async () => {
    const source = createRecord();
    const before = structuredClone(source);
    record = source;

    await service.recover(OPERATION_ID);

    expect(source).toEqual(before);
  });

  it('fails closed before Circle transfer when the treasury wallet ID is absent', async () => {
    delete process.env.CIRCLE_WALLET_ID_ARC;

    const result = await service.recover(OPERATION_ID);

    expect(result.status).toBe('execution_recovery_required');
    expect(result.executionError).toBe(
      'App Wallet swap execution is not available.',
    );
    expect(circleExecutor.getWalletBalance).not.toHaveBeenCalled();
    expect(circleExecutor.submitTransfer).not.toHaveBeenCalled();
  });

  it('persists the execution error before releasing the lease', async () => {
    circleExecutor.getWalletBalance.mockRejectedValue(
      new Error('balance down'),
    );

    await service.recover(OPERATION_ID);

    const errorWrite = repository.update.mock.calls.findIndex(
      ([, data]) => data.executionError === 'balance down',
    );
    expect(errorWrite).toBeGreaterThanOrEqual(0);
    expect(repository.update.mock.invocationCallOrder[errorWrite]).toBeLessThan(
      repository.releaseExecutionLease.mock.invocationCallOrder[0],
    );
  });

  it('preserves provider calls and lifecycle writes in their existing order', async () => {
    await service.recover(OPERATION_ID);

    const pendingWrite = repository.update.mock.calls.findIndex(
      ([, data]) => data.status === 'refund_pending',
    );
    const submittedWrite = repository.update.mock.calls.findIndex(
      ([, data]) => data.status === 'refund_submitted',
    );
    const confirmedWrite = repository.update.mock.calls.findIndex(
      ([, data]) => data.status === 'refunded',
    );

    expect(
      circleExecutor.getWalletBalance.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.update.mock.invocationCallOrder[pendingWrite]);
    expect(
      repository.update.mock.invocationCallOrder[pendingWrite],
    ).toBeLessThan(circleExecutor.submitTransfer.mock.invocationCallOrder[0]);
    expect(
      circleExecutor.submitTransfer.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.update.mock.invocationCallOrder[submittedWrite]);
    expect(
      repository.update.mock.invocationCallOrder[submittedWrite],
    ).toBeLessThan(treasuryVerifier.verifyPayout.mock.invocationCallOrder[0]);
    expect(
      treasuryVerifier.verifyPayout.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.update.mock.invocationCallOrder[confirmedWrite]);
  });
});

describe('AppWalletSwapService refund admission boundary', () => {
  let record: AppWalletSwapOperation | null;
  let repository: jest.Mocked<
    Pick<AppWalletSwapOperationRepository, 'findById'>
  >;
  let refundService: jest.Mocked<Pick<AppWalletSwapRefundService, 'recover'>>;
  let service: AppWalletSwapService;

  beforeEach(() => {
    record = createRecord();
    repository = {
      findById: jest.fn(async (operationId) =>
        record?.operationId === operationId ? record : null,
      ),
    };
    refundService = {
      recover: jest.fn().mockResolvedValue({
        operationId: OPERATION_ID,
        status: 'refund_submitted',
      }),
    };
    service = new AppWalletSwapService(
      {} as UserSwapService,
      {} as AppWalletSwapDepositService,
      refundService as AppWalletSwapRefundService,
      {} as AppWalletSwapTreasuryVerifierService,
      {} as AppWalletSwapCircleExecutorService,
      {} as AppWalletSwapStablefxExecutorService,
      {} as AppWalletSwapPayoutExecutorService,
      repository as AppWalletSwapOperationRepository,
    );
  });

  it('rejects malformed operation IDs before repository or stage access', async () => {
    await expect(service.refund('not-a-uuid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.findById).not.toHaveBeenCalled();
    expect(refundService.recover).not.toHaveBeenCalled();
  });

  it('rejects missing operations before stage access', async () => {
    await expect(service.refund(MISSING_OPERATION_ID)).rejects.toMatchObject({
      response: { code: 'APP_WALLET_SWAP_INVALID_REQUEST' },
    });
    expect(refundService.recover).not.toHaveBeenCalled();
  });

  it('fails closed for a NULL legacy provider before stage lease acquisition', async () => {
    record = createRecord({ executionProvider: null });

    await expect(service.refund(OPERATION_ID)).rejects.toMatchObject({
      response: { code: 'APP_WALLET_SWAP_EXECUTION_PROVIDER_INVALID' },
    });
    expect(refundService.recover).not.toHaveBeenCalled();
  });

  it.each([
    'awaiting_user_deposit',
    'deposit_confirmed',
    'treasury_swap_submitted',
    'completed',
  ] as AppWalletSwapOperationStatus[])(
    'rejects ineligible %s lifecycle state before stage access',
    async (status) => {
      record = createRecord({ status });

      await expect(service.refund(OPERATION_ID)).rejects.toMatchObject({
        response: { code: 'APP_WALLET_SWAP_REFUND_NOT_SAFE' },
      });
      expect(refundService.recover).not.toHaveBeenCalled();
    },
  );

  it('returns an already-refunded public operation without stage access', async () => {
    record = createRecord({
      status: 'refunded',
      refundAmount: '1000000',
      refundTransactionId: 'refund-transaction-1',
      refundTxHash: REFUND_TX_HASH,
      refundSubmittedAt: UPDATED_AT,
      refundConfirmedAt: UPDATED_AT,
    });

    const result = await service.refund(OPERATION_ID);

    expect(result.status).toBe('refunded');
    expect(result.provider).toBe('swapkit');
    expect(refundService.recover).not.toHaveBeenCalled();
  });

  it.each([
    'execution_recovery_required',
    'execution_failed',
    'refund_pending',
    'refund_submitted',
  ] as AppWalletSwapOperationStatus[])(
    'delegates eligible %s lifecycle state to the refund stage',
    async (status) => {
      record = createRecord({ status });

      await service.refund(OPERATION_ID);

      expect(refundService.recover).toHaveBeenCalledWith(OPERATION_ID);
    },
  );
});
