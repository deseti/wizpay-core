import { AppWalletSwapOperation } from '@prisma/client';
import { createHash } from 'crypto';
import { AppWalletSwapOperationRepository } from './app-wallet-swap-operation.repository';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import {
  AppWalletSwapPayoutService,
  AppWalletSwapPayoutTerminalError,
} from './app-wallet-swap-payout.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import { APP_WALLET_SWAP_CHAIN } from './app-wallet-swap.types';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ADDRESS = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const TREASURY_ADDRESS = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b';
const PAYOUT_TX_HASH =
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
    status: 'treasury_swap_confirmed',
    executionProvider: 'swapkit',
    quoteId: 'quote-1',
    rawQuote: { provider: 'swapkit' },
    depositTxHash: null,
    circleTransactionId: 'deposit-transaction-1',
    circleReferenceId: 'app-wallet-swap-deposit-1',
    circleWalletId: 'user-wallet-1',
    depositSubmittedAt: CREATED_AT,
    depositConfirmedAt: CREATED_AT,
    depositConfirmedAmount: '1000000',
    depositConfirmationError: null,
    executionEnabled: true,
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    treasurySwapId: 'treasury-swap-1',
    treasurySwapQuoteId: 'treasury-quote-1',
    treasurySwapTxHash: PAYOUT_TX_HASH,
    treasurySwapSubmittedAt: CREATED_AT,
    treasurySwapConfirmedAt: CREATED_AT,
    treasurySwapExpectedOutput: '970000',
    treasurySwapActualOutput: '980000',
    rawTreasurySwap: { status: 'confirmed' },
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
  };
}

function expectedIdempotencyKey(): string {
  const hex = createHash('sha256')
    .update(`${OPERATION_ID}:payout`)
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

describe('AppWalletSwapPayoutService', () => {
  const originalEnv = process.env;
  let record: AppWalletSwapOperation;
  let repository: jest.Mocked<Pick<AppWalletSwapOperationRepository, 'update'>>;
  let payoutExecutor: jest.Mocked<
    Pick<
      AppWalletSwapPayoutExecutorService,
      | 'getPayoutStatus'
      | 'getStoredPayoutReferences'
      | 'recoverPayoutReference'
      | 'submitPayout'
    >
  >;
  let treasuryVerifier: jest.Mocked<
    Pick<AppWalletSwapTreasuryVerifierService, 'verifyPayout'>
  >;
  let service: AppWalletSwapPayoutService;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      CIRCLE_WALLET_ID_ARC: 'treasury-wallet-1',
    };
    record = createRecord();
    repository = {
      update: jest.fn((operationId, data) => {
        expect(operationId).toBe(OPERATION_ID);
        record = { ...record, ...data };
        return Promise.resolve(record);
      }),
    };
    payoutExecutor = {
      getPayoutStatus: jest.fn(),
      getStoredPayoutReferences: jest.fn().mockReturnValue({
        transactionId: null,
        txHash: null,
      }),
      recoverPayoutReference: jest.fn().mockResolvedValue(null),
      submitPayout: jest.fn().mockResolvedValue({
        transactionId: 'payout-transaction-1',
        txHash: PAYOUT_TX_HASH,
        providerStatus: 'COMPLETE',
        snapshot: {
          provider: 'circle',
          transactionId: 'payout-transaction-1',
          txHash: PAYOUT_TX_HASH,
        },
      }),
    };
    treasuryVerifier = {
      verifyPayout: jest.fn().mockResolvedValue({ confirmed: true }),
    };
    service = new AppWalletSwapPayoutService(
      payoutExecutor as AppWalletSwapPayoutExecutorService,
      treasuryVerifier as AppWalletSwapTreasuryVerifierService,
      repository as AppWalletSwapOperationRepository,
    );
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('persists payout intent before submitting treasury actual output with a stable key', async () => {
    record = createRecord({ treasurySwapActualOutput: '975123' });

    const result = await service.progress(record as never);

    expect(repository.update.mock.calls[0][1]).toMatchObject({
      status: 'payout_pending',
    });
    expect(payoutExecutor.submitPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        payoutAmount: '975123',
        idempotencyKey: expectedIdempotencyKey(),
      }),
    );
    expect(repository.update.mock.invocationCallOrder[0]).toBeLessThan(
      payoutExecutor.submitPayout.mock.invocationCallOrder[0],
    );
    expect(
      payoutExecutor.submitPayout.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.update.mock.invocationCallOrder[1]);
    expect(result.status).toBe('completed');
    expect(result.payoutAmount).toBe('975123');
  });

  it('does not submit or persist without treasury actual output', async () => {
    const input = createRecord({ treasurySwapActualOutput: null });

    const result = await service.progress(input as never);

    expect(result).toBe(input);
    expect(repository.update).not.toHaveBeenCalled();
    expect(payoutExecutor.submitPayout).not.toHaveBeenCalled();
  });

  it('does not submit payout before treasury swap confirmation', async () => {
    const input = createRecord({ treasurySwapConfirmedAt: null });

    const result = await service.progress(input as never);

    expect(result).toBe(input);
    expect(repository.update).not.toHaveBeenCalled();
    expect(payoutExecutor.submitPayout).not.toHaveBeenCalled();
  });

  it('resumes a submitted payout without submitting twice', async () => {
    record = createRecord({
      status: 'payout_submitted',
      payoutAmount: '980000',
      payoutSubmittedAt: UPDATED_AT,
      payoutTxHash: PAYOUT_TX_HASH,
      rawPayout: { transactionId: 'payout-transaction-1' },
    });

    const result = await service.progress(record as never);

    expect(payoutExecutor.submitPayout).not.toHaveBeenCalled();
    expect(treasuryVerifier.verifyPayout).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('polls the stored Circle transaction before attempting list recovery', async () => {
    record = createRecord({
      status: 'payout_submitted',
      payoutAmount: '980000',
      payoutSubmittedAt: UPDATED_AT,
      rawPayout: { transactionId: 'payout-transaction-1' },
    });
    payoutExecutor.getStoredPayoutReferences.mockReturnValue({
      transactionId: 'payout-transaction-1',
      txHash: null,
    });
    payoutExecutor.getPayoutStatus.mockResolvedValue({
      transactionId: 'payout-transaction-1',
      txHash: PAYOUT_TX_HASH,
      providerStatus: 'COMPLETE',
      failed: false,
      errorReason: null,
      snapshot: { state: 'COMPLETE' },
    });

    await service.progress(record as never);

    expect(payoutExecutor.getPayoutStatus).toHaveBeenCalledWith(
      'payout-transaction-1',
    );
    expect(payoutExecutor.recoverPayoutReference).not.toHaveBeenCalled();
  });

  it('uses strict executor list recovery only when direct evidence has no hash', async () => {
    record = createRecord({
      status: 'payout_submitted',
      payoutAmount: '980000',
      payoutSubmittedAt: UPDATED_AT,
      rawPayout: { transactionId: 'payout-transaction-1' },
    });
    payoutExecutor.getStoredPayoutReferences.mockReturnValue({
      transactionId: 'payout-transaction-1',
      txHash: null,
    });
    payoutExecutor.getPayoutStatus.mockResolvedValue({
      transactionId: 'payout-transaction-1',
      txHash: null,
      providerStatus: 'PENDING',
      failed: false,
      errorReason: null,
      snapshot: { state: 'PENDING' },
    });
    payoutExecutor.recoverPayoutReference.mockResolvedValue({
      transactionId: 'payout-transaction-1',
      txHash: PAYOUT_TX_HASH,
      providerStatus: 'COMPLETE',
      snapshot: { state: 'COMPLETE' },
    });

    const result = await service.progress(record as never);

    expect(payoutExecutor.recoverPayoutReference).toHaveBeenCalledWith(
      expect.objectContaining({
        treasuryWalletId: 'treasury-wallet-1',
        existingTransactionId: 'payout-transaction-1',
      }),
    );
    expect(result.payoutTxHash).toBe(PAYOUT_TX_HASH);
    expect(result.status).toBe('completed');
  });

  it('never completes without accepted on-chain verification', async () => {
    record = createRecord({
      status: 'payout_submitted',
      payoutAmount: '980000',
      payoutSubmittedAt: UPDATED_AT,
      payoutTxHash: PAYOUT_TX_HASH,
    });
    treasuryVerifier.verifyPayout.mockResolvedValue({ confirmed: false });

    const result = await service.progress(record as never);

    expect(result.status).toBe('payout_submitted');
    expect(result.payoutConfirmedAt).toBeNull();
    expect(
      repository.update.mock.calls.some(
        ([, data]) => data.status === 'completed',
      ),
    ).toBe(false);
  });

  it('surfaces failed direct provider status as a terminal payout error', async () => {
    record = createRecord({
      status: 'payout_submitted',
      payoutAmount: '980000',
      payoutSubmittedAt: UPDATED_AT,
      rawPayout: { transactionId: 'payout-transaction-1' },
    });
    payoutExecutor.getStoredPayoutReferences.mockReturnValue({
      transactionId: 'payout-transaction-1',
      txHash: null,
    });
    payoutExecutor.getPayoutStatus.mockResolvedValue({
      transactionId: 'payout-transaction-1',
      txHash: null,
      providerStatus: 'FAILED',
      failed: true,
      errorReason: 'reverted',
      snapshot: { state: 'FAILED' },
    });

    await expect(service.progress(record as never)).rejects.toEqual(
      expect.any(AppWalletSwapPayoutTerminalError),
    );
    expect(payoutExecutor.recoverPayoutReference).not.toHaveBeenCalled();
    expect(treasuryVerifier.verifyPayout).not.toHaveBeenCalled();
  });

  it('treats completed payout progression as an idempotent no-op', async () => {
    const completed = createRecord({
      status: 'completed',
      payoutAmount: '980000',
      payoutSubmittedAt: UPDATED_AT,
      payoutTxHash: PAYOUT_TX_HASH,
      payoutConfirmedAt: UPDATED_AT,
      completedAt: UPDATED_AT,
    });

    const result = await service.progress(completed as never);

    expect(result).toBe(completed);
    expect(repository.update).not.toHaveBeenCalled();
    expect(payoutExecutor.submitPayout).not.toHaveBeenCalled();
    expect(treasuryVerifier.verifyPayout).not.toHaveBeenCalled();
  });
});
