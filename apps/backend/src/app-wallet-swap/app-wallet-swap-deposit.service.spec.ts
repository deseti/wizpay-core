import { AppWalletSwapOperation } from '@prisma/client';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { AppWalletSwapDepositService } from './app-wallet-swap-deposit.service';
import { AppWalletSwapOperationRepository } from './app-wallet-swap-operation.repository';
import { APP_WALLET_SWAP_CHAIN } from './app-wallet-swap.types';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ADDRESS = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const TREASURY_ADDRESS = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b';
const DEPOSIT_TX_HASH =
  '0xdd019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
const SECOND_DEPOSIT_TX_HASH =
  '0xde019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
const SUBMITTED_AT = new Date('2099-01-01T00:00:10.000Z');

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
    status: 'deposit_submitted',
    executionProvider: 'swapkit',
    quoteId: 'quote-1',
    rawQuote: { provider: 'swapkit' },
    depositTxHash: null,
    circleTransactionId: 'circle-transaction-1',
    circleReferenceId: 'circle-reference-1',
    circleWalletId: 'circle-wallet-1',
    depositSubmittedAt: SUBMITTED_AT,
    depositConfirmedAt: null,
    depositConfirmedAmount: null,
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
    createdAt: new Date('2099-01-01T00:00:00.000Z'),
    updatedAt: SUBMITTED_AT,
    ...overrides,
  } as AppWalletSwapOperation;
}

function createTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'circle-transaction-1',
    refId: 'circle-reference-1',
    txHash: DEPOSIT_TX_HASH,
    blockchain: APP_WALLET_SWAP_CHAIN,
    walletId: 'circle-wallet-1',
    sourceAddress: USER_ADDRESS,
    destinationAddress: TREASURY_ADDRESS,
    tokenSymbol: 'USDC',
    amount: '1',
    state: 'COMPLETE',
    operation: 'TRANSFER',
    transactionType: 'OUTBOUND',
    createDate: SUBMITTED_AT.toISOString(),
    ...overrides,
  };
}

describe('AppWalletSwapDepositService', () => {
  let record: AppWalletSwapOperation | null;
  let repository: jest.Mocked<
    Pick<AppWalletSwapOperationRepository, 'findById' | 'update'>
  >;
  let circleExecutor: jest.Mocked<
    Pick<
      AppWalletSwapCircleExecutorService,
      'getW3sTransaction' | 'listW3sTransactions'
    >
  >;
  let depositVerifier: jest.Mocked<
    Pick<AppWalletSwapDepositVerifierService, 'verifyDeposit'>
  >;
  let service: AppWalletSwapDepositService;

  beforeEach(() => {
    record = createRecord();
    repository = {
      findById: jest.fn(async (operationId) =>
        record?.operationId === operationId ? record : null,
      ),
      update: jest.fn(async (operationId, data) => {
        if (!record || record.operationId !== operationId) {
          throw new Error('Record not found');
        }

        record = { ...record, ...data } as AppWalletSwapOperation;
        return record;
      }),
    };
    circleExecutor = {
      getW3sTransaction: jest.fn(),
      listW3sTransactions: jest.fn().mockResolvedValue({ transactions: [] }),
    };
    depositVerifier = {
      verifyDeposit: jest.fn().mockResolvedValue({
        confirmed: true,
        confirmedAmount: '1000000',
      }),
    };
    service = new AppWalletSwapDepositService(
      depositVerifier as AppWalletSwapDepositVerifierService,
      circleExecutor as AppWalletSwapCircleExecutorService,
      repository as AppWalletSwapOperationRepository,
    );
  });

  it('persists deposit submission fields and status in the original order', async () => {
    record = createRecord({
      status: 'awaiting_user_deposit',
      depositSubmittedAt: null,
      circleTransactionId: null,
      circleReferenceId: null,
      circleWalletId: null,
    });

    const result = await service.submitDeposit(OPERATION_ID, {
      depositTxHash: `  ${DEPOSIT_TX_HASH}  `,
      circleWalletId: ' circle-wallet-1 ',
      circleTransactionId: ' circle-transaction-1 ',
      circleReferenceId: ' circle-reference-1 ',
    });

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash: DEPOSIT_TX_HASH,
      circleWalletId: 'circle-wallet-1',
      circleTransactionId: 'circle-transaction-1',
      circleReferenceId: 'circle-reference-1',
    });
    expect(repository.findById).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({
        status: 'deposit_submitted',
        depositSubmittedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    );
    expect(repository.findById.mock.invocationCallOrder[0]).toBeLessThan(
      repository.update.mock.invocationCallOrder[0],
    );
    expect(circleExecutor.getW3sTransaction).not.toHaveBeenCalled();
    expect(circleExecutor.listW3sTransactions).not.toHaveBeenCalled();
  });

  it('preserves deposit txHash attachment validation and write shape', async () => {
    await expect(
      service.attachDepositTxHash(OPERATION_ID, {
        depositTxHash: '0x1234',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        message: 'depositTxHash must be a 32-byte transaction hash.',
      },
    });
    expect(repository.update).not.toHaveBeenCalled();

    const result = await service.attachDepositTxHash(OPERATION_ID, {
      depositTxHash: DEPOSIT_TX_HASH,
    });

    expect(result.depositTxHash).toBe(DEPOSIT_TX_HASH);
    expect(repository.update).toHaveBeenCalledWith(OPERATION_ID, {
      depositTxHash: DEPOSIT_TX_HASH,
      depositConfirmationError: null,
      updatedAt: expect.any(Date),
    });
  });

  it('uses a matching direct W3S transaction before list fallback', async () => {
    circleExecutor.getW3sTransaction.mockResolvedValue({
      transaction: createTransaction(),
    });

    const result = await service.resolveDepositTxHash(OPERATION_ID);

    expect(result.depositTxHash).toBe(DEPOSIT_TX_HASH);
    expect(circleExecutor.getW3sTransaction).toHaveBeenCalledWith(
      'circle-transaction-1',
    );
    expect(circleExecutor.listW3sTransactions).not.toHaveBeenCalled();
    expect(
      circleExecutor.getW3sTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.update.mock.invocationCallOrder[0]);
  });

  it('keeps a pending direct result unresolved and proceeds to list fallback', async () => {
    circleExecutor.getW3sTransaction.mockResolvedValue({
      transaction: createTransaction({ state: 'PENDING' }),
    });

    const result = await service.resolveDepositTxHash(OPERATION_ID);

    expect(circleExecutor.listW3sTransactions).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('deposit_submitted');
    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available from Circle yet. Retry shortly.',
    );
  });

  it('falls back to the current transaction list after direct lookup failure', async () => {
    circleExecutor.getW3sTransaction.mockRejectedValue(new Error('Not found'));
    circleExecutor.listW3sTransactions.mockResolvedValue({
      transactions: [createTransaction()],
    });

    const result = await service.resolveDepositTxHash(OPERATION_ID);

    expect(result.depositTxHash).toBe(DEPOSIT_TX_HASH);
    expect(
      circleExecutor.getW3sTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(
      circleExecutor.listW3sTransactions.mock.invocationCallOrder[0],
    );
  });

  it('preserves first-valid list candidate input order', async () => {
    record = createRecord({
      circleTransactionId: null,
      circleReferenceId: null,
    });
    circleExecutor.listW3sTransactions.mockResolvedValue({
      transactions: [
        createTransaction({ txHash: DEPOSIT_TX_HASH }),
        createTransaction({ txHash: SECOND_DEPOSIT_TX_HASH }),
      ],
    });

    const result = await service.resolveDepositTxHash(OPERATION_ID);

    expect(result.depositTxHash).toBe(DEPOSIT_TX_HASH);
  });

  it.each([
    ['source', { sourceAddress: '0x1111111111111111111111111111111111111111' }],
    [
      'destination',
      { destinationAddress: '0x1111111111111111111111111111111111111111' },
    ],
    ['token', { tokenSymbol: 'EURC' }],
    ['amount', { amount: '0.999999' }],
  ])(
    'rejects a candidate with the wrong %s',
    async (_, transactionOverrides) => {
      record = createRecord({
        circleTransactionId: null,
        circleReferenceId: null,
      });
      circleExecutor.listW3sTransactions.mockResolvedValue({
        transactions: [createTransaction(transactionOverrides)],
      });

      const result = await service.resolveDepositTxHash(OPERATION_ID);

      expect(result).not.toHaveProperty('depositTxHash');
      expect(repository.update).toHaveBeenLastCalledWith(
        OPERATION_ID,
        expect.objectContaining({
          depositConfirmationError:
            'Deposit txHash is not available from Circle yet. Retry shortly.',
        }),
      );
    },
  );

  it('preserves case-insensitive EVM address matching', async () => {
    circleExecutor.getW3sTransaction.mockResolvedValue({
      transaction: createTransaction({
        sourceAddress: USER_ADDRESS.toUpperCase(),
        destinationAddress: TREASURY_ADDRESS.toUpperCase(),
      }),
    });

    await expect(
      service.resolveDepositTxHash(OPERATION_ID),
    ).resolves.toMatchObject({
      depositTxHash: DEPOSIT_TX_HASH,
    });
  });

  it.each([
    null,
    {},
    { transaction: null },
    { transactions: [null, 'malformed', { nested: true }] },
  ])(
    'handles malformed or partial Circle response %# without throwing',
    async (response) => {
      circleExecutor.getW3sTransaction.mockResolvedValue(
        response as Record<string, unknown>,
      );
      circleExecutor.listW3sTransactions.mockResolvedValue(
        response as Record<string, unknown>,
      );

      await expect(
        service.resolveDepositTxHash(OPERATION_ID),
      ).resolves.toMatchObject({
        status: 'deposit_submitted',
        depositConfirmationError:
          'Deposit txHash is not available from Circle yet. Retry shortly.',
      });
    },
  );

  it('preserves missing identifier and missing txHash behavior', async () => {
    record = createRecord({
      circleTransactionId: null,
      circleReferenceId: null,
      circleWalletId: null,
    });

    await expect(
      service.resolveDepositTxHash(OPERATION_ID),
    ).rejects.toMatchObject({
      response: {
        message:
          'Circle transaction, reference id, or wallet id is required before resolving a deposit txHash.',
      },
    });

    record = createRecord({ depositTxHash: null });
    const result = await service.confirmDeposit(OPERATION_ID);

    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available yet. Circle reference alone is not on-chain confirmation.',
    );
    expect(depositVerifier.verifyDeposit).not.toHaveBeenCalled();
  });

  it('preserves operation-specific Circle refId lookup', async () => {
    record = createRecord({
      circleTransactionId: null,
      circleReferenceId: 'operation-specific-ref',
    });
    circleExecutor.getW3sTransaction.mockResolvedValue({
      transaction: createTransaction({
        id: 'provider-transaction-id',
        refId: 'operation-specific-ref',
      }),
    });

    const result = await service.resolveDepositTxHash(OPERATION_ID);

    expect(circleExecutor.getW3sTransaction).toHaveBeenCalledWith(
      'operation-specific-ref',
    );
    expect(result.depositTxHash).toBe(DEPOSIT_TX_HASH);
  });

  it('does not advance status when on-chain verification fails', async () => {
    record = createRecord({ depositTxHash: DEPOSIT_TX_HASH });
    depositVerifier.verifyDeposit.mockResolvedValue({
      confirmed: false,
      error: 'Synthetic verification failure.',
    });

    const result = await service.confirmDeposit(OPERATION_ID);

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositConfirmationError: 'Synthetic verification failure.',
    });
    expect(repository.update).not.toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'deposit_confirmed' }),
    );
  });

  it('persists the confirmed amount and status only after verification', async () => {
    record = createRecord({ depositTxHash: DEPOSIT_TX_HASH });
    depositVerifier.verifyDeposit.mockResolvedValue({
      confirmed: true,
      confirmedAmount: '1000001',
    });

    const result = await service.confirmDeposit(OPERATION_ID);

    expect(result).toMatchObject({
      status: 'deposit_confirmed',
      depositConfirmedAmount: '1000001',
    });
    expect(result).not.toHaveProperty('depositConfirmationError');
    expect(
      depositVerifier.verifyDeposit.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.update.mock.invocationCallOrder[0]);
    expect(repository.update).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({
        status: 'deposit_confirmed',
        depositConfirmedAmount: '1000001',
        depositConfirmedAt: expect.any(Date),
        depositConfirmationError: null,
      }),
    );
  });

  it('preserves repeated confirmation behavior after the first success', async () => {
    record = createRecord({ depositTxHash: DEPOSIT_TX_HASH });

    await service.confirmDeposit(OPERATION_ID);
    await expect(service.confirmDeposit(OPERATION_ID)).rejects.toMatchObject({
      response: {
        message:
          'App Wallet swap operation must be deposit_submitted before deposit confirmation.',
      },
    });
    expect(depositVerifier.verifyDeposit).toHaveBeenCalledTimes(1);
  });

  it('rejects inaccessible operations before any provider or repository write', async () => {
    record = null;

    await expect(
      service.submitDeposit(OPERATION_ID, { depositTxHash: DEPOSIT_TX_HASH }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        message: 'App Wallet swap operation was not found.',
      },
    });
    expect(repository.update).not.toHaveBeenCalled();
    expect(circleExecutor.getW3sTransaction).not.toHaveBeenCalled();
    expect(circleExecutor.listW3sTransactions).not.toHaveBeenCalled();
    expect(depositVerifier.verifyDeposit).not.toHaveBeenCalled();
  });

  it('preserves repository and external call order through fallback attachment', async () => {
    circleExecutor.getW3sTransaction.mockRejectedValue(new Error('Not found'));
    circleExecutor.listW3sTransactions.mockResolvedValue({
      transactions: [createTransaction()],
    });

    await service.resolveDepositTxHash(OPERATION_ID);

    const firstRead = repository.findById.mock.invocationCallOrder[0];
    const directLookup =
      circleExecutor.getW3sTransaction.mock.invocationCallOrder[0];
    const listLookup =
      circleExecutor.listW3sTransactions.mock.invocationCallOrder[0];
    const attachmentRead = repository.findById.mock.invocationCallOrder[1];
    const attachmentWrite = repository.update.mock.invocationCallOrder[0];

    expect(firstRead).toBeLessThan(directLookup);
    expect(directLookup).toBeLessThan(listLookup);
    expect(listLookup).toBeLessThan(attachmentRead);
    expect(attachmentRead).toBeLessThan(attachmentWrite);
  });

  it('does not mutate input operation records or Circle payloads', async () => {
    const sourceRecord = createRecord();
    const transaction = createTransaction();
    record = sourceRecord;
    const recordBefore = structuredClone(sourceRecord);
    const transactionBefore = structuredClone(transaction);
    circleExecutor.getW3sTransaction.mockResolvedValue({ transaction });

    await service.resolveDepositTxHash(OPERATION_ID);

    expect(sourceRecord).toEqual(recordBefore);
    expect(transaction).toEqual(transactionBefore);
  });

  it('keeps NULL legacy provider classification outside the deposit stage', async () => {
    record = createRecord({
      executionProvider: null,
      depositTxHash: DEPOSIT_TX_HASH,
    });

    const result = await service.confirmDeposit(OPERATION_ID);

    expect(result).not.toHaveProperty('provider');
    expect(result.status).toBe('deposit_confirmed');
    expect(circleExecutor.getW3sTransaction).not.toHaveBeenCalled();
    expect(circleExecutor.listW3sTransactions).not.toHaveBeenCalled();
  });
});
