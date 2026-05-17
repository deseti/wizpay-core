import { BadRequestException } from '@nestjs/common';
import { AppWalletSwapOperation } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
import { CircleService } from '../adapters/circle.service';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { AppWalletSwapService } from './app-wallet-swap.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_MODE,
} from './app-wallet-swap.types';
import {
  USER_SWAP_EURC_ADDRESS,
  UserSwapService,
} from '../user-swap/user-swap.service';

const TREASURY_ADDRESS = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b';
const USER_ADDRESS = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';

const baseRequest = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '1000000',
  fromAddress: USER_ADDRESS,
  chain: APP_WALLET_SWAP_CHAIN,
};
const depositTxHash =
  '0xdd019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
const arcTestnetCircleUsdcTokenId = '15dc2b5d-0994-58b0-bf8c-3a0501148ee8';
const arcTestnetCircleEurcTokenId = '4ea52a96-e6ae-56dc-8336-385bb238755f';
const invalidOperationId = '2bdaccac7-2d53-491a-8ef6-8ca3256a1162';
const missingOperationId = '2bdaccac-2d53-491a-8ef6-8ca3256a1162';

describe('AppWalletSwapService', () => {
  const originalEnv = process.env;
  const userSwapService = {
    quote: jest.fn(),
    prepare: jest.fn(),
  } as unknown as jest.Mocked<Pick<UserSwapService, 'quote' | 'prepare'>>;
  const depositVerifier = {
    verifyDeposit: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<AppWalletSwapDepositVerifierService, 'verifyDeposit'>
  >;
  const treasuryVerifier = {
    verifyTreasurySwap: jest.fn(),
    verifyPayout: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      AppWalletSwapTreasuryVerifierService,
      'verifyTreasurySwap' | 'verifyPayout'
    >
  >;
  const circleService = {
    executeContract: jest.fn(),
    getTransactionStatus: jest.fn(),
    transfer: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      CircleService,
      'executeContract' | 'getTransactionStatus' | 'transfer'
    >
  >;
  const w3sAuthService = {
    getTransaction: jest.fn(),
    listTransactions: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<W3sAuthService, 'getTransaction' | 'listTransactions'>
  >;
  let appWalletSwapOperationStore: Map<string, AppWalletSwapOperation>;
  let prisma: {
    appWalletSwapOperation: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      CIRCLE_WALLET_ADDRESS_ARC: TREASURY_ADDRESS,
    };
    userSwapService.quote.mockResolvedValue({
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      fromAddress: TREASURY_ADDRESS,
      toAddress: USER_ADDRESS,
      chain: APP_WALLET_SWAP_CHAIN,
      quoteId: 'quote-1',
      expectedOutput: '990000',
      minimumOutput: '970000',
      expiresAt: '2026-05-16T12:00:00.000Z',
      raw: { quoteId: 'quote-1' },
    });
    userSwapService.prepare.mockResolvedValue({
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      fromAddress: TREASURY_ADDRESS,
      toAddress: TREASURY_ADDRESS,
      chain: APP_WALLET_SWAP_CHAIN,
      expectedOutput: '990000',
      minimumOutput: '970000',
      transaction: {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        raw: { to: '0x1111111111111111111111111111111111111111' },
      },
      raw: { quoteId: 'treasury-quote-1' },
    });
    depositVerifier.verifyDeposit.mockResolvedValue({
      confirmed: true,
      confirmedAmount: baseRequest.amountIn,
    });
    w3sAuthService.getTransaction.mockResolvedValue({
      transaction: {
        id: 'transaction-1',
        state: 'INITIATED',
      },
    });
    w3sAuthService.listTransactions.mockResolvedValue({
      transactions: [],
    });
    treasuryVerifier.verifyTreasurySwap.mockResolvedValue({
      confirmed: true,
      actualOutput: '990000',
    });
    treasuryVerifier.verifyPayout.mockResolvedValue({
      confirmed: true,
    });
    circleService.executeContract.mockResolvedValue({
      txId: 'treasury-swap-transaction-1',
      status: 'SENT',
      txHash:
        '0xaa019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5',
      raw: { id: 'treasury-swap-transaction-1' },
    });
    circleService.getTransactionStatus.mockResolvedValue({
      txId: 'circle-transaction-1',
      status: 'COMPLETE',
      txHash:
        '0xbb019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5',
      blockNumber: '1',
      errorReason: null,
    });
    circleService.transfer.mockResolvedValue({
      txId: 'payout-transaction-1',
      status: 'SENT',
      txHash:
        '0xcc019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5',
    });
    appWalletSwapOperationStore = new Map();
    prisma = createPrismaMock(appWalletSwapOperationStore);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function createService(prismaService = prisma) {
    return new AppWalletSwapService(
      userSwapService as UserSwapService,
      depositVerifier as AppWalletSwapDepositVerifierService,
      treasuryVerifier as AppWalletSwapTreasuryVerifierService,
      circleService as unknown as CircleService,
      w3sAuthService as W3sAuthService,
      prismaService as unknown as PrismaService,
    );
  }

  function enableExecutionEnv() {
    process.env = {
      ...process.env,
      APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED: 'true',
      CIRCLE_WALLET_ID_ARC: 'circle-wallet-arc-1',
      CIRCLE_WALLET_ADDRESS_ARC: TREASURY_ADDRESS,
      CIRCLE_API_KEY: 'configured',
      CIRCLE_ENTITY_SECRET: 'configured',
      WIZPAY_USER_SWAP_ENABLED: 'true',
      WIZPAY_USER_SWAP_ALLOW_TESTNET: 'true',
      WIZPAY_USER_SWAP_KIT_KEY: 'configured',
    };
  }

  async function createConfirmedOperation(service = createService()) {
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      depositTxHash,
    });

    return service.confirmDeposit(submitted.operationId);
  }

  async function createPayoutSubmittedOperation(service = createService()) {
    const confirmed = await createConfirmedOperation(service);
    const payoutSubmittedAt = new Date('2026-05-17T01:00:00.000Z');
    const record = appWalletSwapOperationStore.get(confirmed.operationId)!;

    appWalletSwapOperationStore.set(confirmed.operationId, {
      ...record,
      status: 'payout_submitted',
      treasurySwapId: 'treasury-swap-transaction-1',
      treasurySwapTxHash:
        '0xaa019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5',
      treasurySwapConfirmedAt: new Date('2026-05-17T00:59:00.000Z'),
      treasurySwapActualOutput: '1042878',
      payoutAmount: '1042878',
      payoutSubmittedAt,
      payoutTxHash: null,
      rawPayout: {
        status: {
          txId: 'payout-transaction-queued',
          status: 'QUEUED',
          txHash: null,
        },
      },
      executionError: null,
      updatedAt: payoutSubmittedAt,
    });

    return service.getOperation(confirmed.operationId);
  }

  function createPrismaMock(
    store: Map<string, AppWalletSwapOperation>,
  ): typeof prisma {
    return {
      appWalletSwapOperation: {
        create: jest.fn(async ({ data }) => {
          const now = new Date();
          const record = {
            ...data,
            depositTxHash: data.depositTxHash ?? null,
            circleTransactionId: data.circleTransactionId ?? null,
            circleReferenceId: data.circleReferenceId ?? null,
            circleWalletId: data.circleWalletId ?? null,
            depositSubmittedAt: data.depositSubmittedAt ?? null,
            depositConfirmedAt: data.depositConfirmedAt ?? null,
            depositConfirmedAmount: data.depositConfirmedAmount ?? null,
            depositConfirmationError: data.depositConfirmationError ?? null,
            treasurySwapId: data.treasurySwapId ?? null,
            treasurySwapQuoteId: data.treasurySwapQuoteId ?? null,
            treasurySwapTxHash: data.treasurySwapTxHash ?? null,
            treasurySwapSubmittedAt: data.treasurySwapSubmittedAt ?? null,
            treasurySwapConfirmedAt: data.treasurySwapConfirmedAt ?? null,
            treasurySwapExpectedOutput:
              data.treasurySwapExpectedOutput ?? null,
            treasurySwapActualOutput: data.treasurySwapActualOutput ?? null,
            rawTreasurySwap: data.rawTreasurySwap ?? null,
            payoutTxHash: data.payoutTxHash ?? null,
            payoutAmount: data.payoutAmount ?? null,
            payoutSubmittedAt: data.payoutSubmittedAt ?? null,
            payoutConfirmedAt: data.payoutConfirmedAt ?? null,
            rawPayout: data.rawPayout ?? null,
            completedAt: data.completedAt ?? null,
            executionError: data.executionError ?? null,
            createdAt: data.createdAt ?? now,
            updatedAt: data.updatedAt ?? now,
          } as AppWalletSwapOperation;
          store.set(record.operationId, record);
          return record;
        }),
        findUnique: jest.fn(async ({ where }) => {
          return store.get(where.operationId) ?? null;
        }),
        update: jest.fn(async ({ where, data }) => {
          const existing = store.get(where.operationId);

          if (!existing) {
            throw new Error('Record not found');
          }

          const updated = {
            ...existing,
            ...data,
            updatedAt: data.updatedAt ?? new Date(),
          } as AppWalletSwapOperation;
          store.set(where.operationId, updated);
          return updated;
        }),
      },
    };
  }

  it('returns a treasury-mediated quote', async () => {
    const result = await createService().quote(baseRequest);

    expect(userSwapService.quote).toHaveBeenCalledWith({
      amountIn: baseRequest.amountIn,
      chain: APP_WALLET_SWAP_CHAIN,
      fromAddress: TREASURY_ADDRESS,
      toAddress: USER_ADDRESS,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
    });
    expect(result).toMatchObject({
      operationMode: APP_WALLET_SWAP_MODE,
      sourceChain: APP_WALLET_SWAP_CHAIN,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      treasuryDepositAddress: TREASURY_ADDRESS,
      expectedOutput: '990000',
      minimumOutput: '970000',
      status: 'quoted',
    });
  });

  it('creates an awaiting_user_deposit operation without a txHash', async () => {
    const result = await createService().createOperation(baseRequest);

    expect(result).toMatchObject({
      operationMode: APP_WALLET_SWAP_MODE,
      sourceChain: APP_WALLET_SWAP_CHAIN,
      status: 'awaiting_user_deposit',
      userWalletAddress: USER_ADDRESS,
      treasuryDepositAddress: TREASURY_ADDRESS,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      executionEnabled: false,
    });
    expect(result.operationId).toEqual(expect.any(String));
    expect(result).not.toHaveProperty('txHash');
    expect(result).not.toHaveProperty('transactionHash');
    expect(result).not.toHaveProperty('payoutTxHash');
  });

  it('persists executionEnabled true for new operations when treasury execution env is enabled', async () => {
    enableExecutionEnv();

    const result = await createService().createOperation(baseRequest);
    const persisted = await createService().getOperation(result.operationId);

    expect(result.executionEnabled).toBe(true);
    expect(persisted.executionEnabled).toBe(true);
  });

  it('persists created operations and reads them back from storage', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    const persisted = await service.getOperation(operation.operationId);

    expect(prisma.appWalletSwapOperation.create).toHaveBeenCalled();
    expect(prisma.appWalletSwapOperation.findUnique).toHaveBeenCalledWith({
      where: { operationId: operation.operationId },
    });
    expect(persisted).toMatchObject({
      operationId: operation.operationId,
      status: 'awaiting_user_deposit',
      rawQuote: { quoteId: 'quote-1' },
      quoteId: 'quote-1',
    });
  });

  it('keeps operations retrievable from a fresh service using the same database', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const freshPrisma = createPrismaMock(appWalletSwapOperationStore);
    const freshService = createService(freshPrisma);

    const persisted = await freshService.getOperation(operation.operationId);

    expect(persisted).toMatchObject({
      operationId: operation.operationId,
      status: 'awaiting_user_deposit',
      amountIn: baseRequest.amountIn,
      treasuryDepositAddress: TREASURY_ADDRESS,
    });
  });

  it('getOperation rejects invalid operationId with APP_WALLET_SWAP_INVALID_REQUEST', async () => {
    prisma.appWalletSwapOperation.findUnique.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid'),
    );

    await expect(
      createService().getOperation(invalidOperationId),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        message: 'App Wallet swap operation id is invalid.',
      },
    });
    expect(prisma.appWalletSwapOperation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects invalid chains', async () => {
    await expect(
      createService().createOperation({ ...baseRequest, chain: 'BASE' }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_UNSUPPORTED_CHAIN',
      },
    });
    expect(userSwapService.quote).not.toHaveBeenCalled();
  });

  it('rejects same-token operations', async () => {
    await expect(
      createService().createOperation({ ...baseRequest, tokenOut: 'USDC' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userSwapService.quote).not.toHaveBeenCalled();
  });

  it('transitions awaiting_user_deposit to deposit_submitted', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    const result = await service.submitDeposit(operation.operationId, {
      depositTxHash,
    });
    const persisted = await service.getOperation(operation.operationId);

    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_submitted',
      depositTxHash,
    });
    expect(persisted).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash,
    });
    expect(result.depositSubmittedAt).toEqual(expect.any(String));
  });

  it('stores Circle transaction and reference diagnostics', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    const result = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleTransactionId: 'transaction-1',
    });

    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_submitted',
      circleReferenceId: 'challenge-1',
      circleTransactionId: 'transaction-1',
    });
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('rejects deposit submission without tx hash or Circle reference', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(async () =>
      service.submitDeposit(operation.operationId, {}),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
      },
    });
  });

  it('rejects invalid deposit tx hash', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(async () =>
      service.submitDeposit(operation.operationId, {
        depositTxHash: '0x1234',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
      },
    });
  });

  it('rejects deposit submission for a missing operation', async () => {
    await expect(
      createService().submitDeposit(missingOperationId, {
        depositTxHash,
      }),
    ).rejects.toThrow('App Wallet swap operation was not found.');
  });

  it('submitDeposit rejects invalid operationId before Prisma throws', async () => {
    prisma.appWalletSwapOperation.findUnique.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid'),
    );

    await expect(
      createService().submitDeposit(invalidOperationId, {
        depositTxHash,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        message: 'App Wallet swap operation id is invalid.',
      },
    });
    expect(prisma.appWalletSwapOperation.findUnique).not.toHaveBeenCalled();
    expect(prisma.appWalletSwapOperation.update).not.toHaveBeenCalled();
  });

  it('does not add payout, treasury swap, refund, or settled fields', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    const result = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('refundTxHash');
    expect(result).not.toHaveProperty('settledAt');
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('attaches deposit txHash to a deposit_submitted operation without confirming', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    const result = await service.attachDepositTxHash(submitted.operationId, {
      depositTxHash,
    });
    const persisted = await service.getOperation(operation.operationId);

    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_submitted',
      circleReferenceId: 'challenge-1',
      depositTxHash,
    });
    expect(persisted.depositTxHash).toBe(depositTxHash);
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('rejects invalid attached deposit txHash', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    await expect(
      service.attachDepositTxHash(submitted.operationId, {
        depositTxHash: '0x1234',
      }),
    ).rejects.toThrow('depositTxHash must be a 32-byte transaction hash.');
  });

  it('rejects attaching deposit txHash before deposit_submitted', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(
      service.attachDepositTxHash(operation.operationId, {
        depositTxHash,
      }),
    ).rejects.toThrow(
      'App Wallet swap operation must be deposit_submitted before attaching a deposit txHash.',
    );
  });

  it('attachDepositTxHash rejects invalid operationId before Prisma throws', async () => {
    prisma.appWalletSwapOperation.findUnique.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid'),
    );

    await expect(
      createService().attachDepositTxHash(invalidOperationId, {
        depositTxHash,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        message: 'App Wallet swap operation id is invalid.',
      },
    });
    expect(prisma.appWalletSwapOperation.findUnique).not.toHaveBeenCalled();
    expect(prisma.appWalletSwapOperation.update).not.toHaveBeenCalled();
  });

  it('still requires verifier success after attaching deposit txHash', async () => {
    depositVerifier.verifyDeposit.mockResolvedValueOnce({
      confirmed: false,
      error: 'Deposit transaction receipt is not successful.',
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });
    const attached = await service.attachDepositTxHash(submitted.operationId, {
      depositTxHash,
    });

    const result = await service.confirmDeposit(attached.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result.depositTxHash).toBe(depositTxHash);
    expect(result.depositConfirmationError).toBe(
      'Deposit transaction receipt is not successful.',
    );
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('resolves txHash from Circle transaction and attaches it without confirming', async () => {
    w3sAuthService.getTransaction.mockResolvedValueOnce({
      transaction: {
        id: 'transaction-1',
        blockchain: APP_WALLET_SWAP_CHAIN,
        walletId: 'circle-wallet-1',
        sourceAddress: USER_ADDRESS,
        destinationAddress: TREASURY_ADDRESS,
        state: 'COMPLETE',
        operation: 'TRANSFER',
        transactionType: 'OUTBOUND',
        contractAddress: '0x3600000000000000000000000000000000000000',
        amounts: ['1'],
        createDate: '2099-01-01T00:00:00.000Z',
        txHash: depositTxHash,
      },
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleTransactionId: 'transaction-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);
    const persisted = await service.getOperation(operation.operationId);

    expect(w3sAuthService.getTransaction).toHaveBeenCalledWith('transaction-1');
    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_submitted',
      circleTransactionId: 'transaction-1',
      depositTxHash,
    });
    expect(persisted.depositTxHash).toBe(depositTxHash);
    expect(persisted.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('keeps deposit_submitted when resolved Circle transaction has no txHash', async () => {
    w3sAuthService.getTransaction.mockResolvedValueOnce({
      transaction: {
        id: 'transaction-1',
        state: 'INITIATED',
      },
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleTransactionId: 'transaction-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available from Circle yet. Retry shortly.',
    );
  });

  it('resolveDepositTxHash rejects invalid operationId before Prisma throws', async () => {
    prisma.appWalletSwapOperation.findUnique.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid'),
    );

    await expect(
      createService().resolveDepositTxHash(invalidOperationId),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        message: 'App Wallet swap operation id is invalid.',
      },
    });
    expect(prisma.appWalletSwapOperation.findUnique).not.toHaveBeenCalled();
    expect(w3sAuthService.getTransaction).not.toHaveBeenCalled();
    expect(w3sAuthService.listTransactions).not.toHaveBeenCalled();
  });

  it('does not attach invalid Circle transaction hash responses', async () => {
    w3sAuthService.getTransaction.mockResolvedValueOnce({
      transaction: {
        id: 'transaction-1',
        txHash: '0x1234',
      },
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleTransactionId: 'transaction-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available from Circle yet. Retry shortly.',
    );
  });

  it('resolves txHash from Circle transaction list by refId without confirming', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          refId: 'challenge-1',
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['1000000'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(w3sAuthService.listTransactions).toHaveBeenCalledWith({
      walletIds: 'circle-wallet-1',
    });
    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash,
    });
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('calls Circle transaction list with blockchain and destination when wallet id is missing', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          refId: 'challenge-1',
          destinationAddress: TREASURY_ADDRESS,
          sourceAddress: USER_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['1000000'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(w3sAuthService.listTransactions).toHaveBeenCalledWith({
      blockchain: APP_WALLET_SWAP_CHAIN,
      destinationAddress: TREASURY_ADDRESS,
    });
    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash,
    });
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('matches Circle list decimal amount without refId when strict transfer fields pass', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['5'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      amountIn: '5000000',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash,
    });
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('resolves txHash from Circle transaction list using Arc Testnet USDC tokenId only', async () => {
    w3sAuthService.listTransactions
      .mockResolvedValueOnce({ transactions: [] })
      .mockResolvedValueOnce({
        transactions: [
          {
            id: '491d75d9-39c6-5a4a-a6fa-baddf5b9c9a5',
            blockchain: APP_WALLET_SWAP_CHAIN,
            tokenId: arcTestnetCircleUsdcTokenId,
            walletId: 'circle-wallet-1',
            sourceAddress: USER_ADDRESS,
            destinationAddress: TREASURY_ADDRESS,
            operation: 'TRANSFER',
            transactionType: 'OUTBOUND',
            state: 'COMPLETE',
            amounts: ['1'],
            createDate: '2099-01-01T00:00:00.000Z',
            txHash: depositTxHash,
          },
        ],
      });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(w3sAuthService.listTransactions).toHaveBeenLastCalledWith({
      walletIds: 'circle-wallet-1',
    });
    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash,
    });
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('completedAt');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('resolves EURC deposit txHash from Circle transaction list using Arc Testnet EURC tokenId and human amount', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValue({
      transactions: [
        {
          id: '50b0b999-a06e-5f8f-8986-80d9e7c5cfae',
          blockchain: APP_WALLET_SWAP_CHAIN,
          tokenId: arcTestnetCircleEurcTokenId,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          amount: '1',
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      amountIn: '1000000',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      depositTxHash,
    });
    expect(result).not.toHaveProperty('depositConfirmationError');
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('resolves EURC deposit txHash from a matching Circle SENT transaction without confirming', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'd8c6d7dc-a909-5313-96e3-26c677386a3b',
          blockchain: APP_WALLET_SWAP_CHAIN,
          tokenId: arcTestnetCircleEurcTokenId,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'SENT',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          amount: '1',
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      amountIn: '1000000',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      depositTxHash,
    });
    expect(result).not.toHaveProperty('depositConfirmationError');
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('rejects Circle transaction list entries with the wrong tokenId', async () => {
    w3sAuthService.listTransactions
      .mockResolvedValueOnce({ transactions: [] })
      .mockResolvedValueOnce({
        transactions: [
          {
            id: 'transaction-2',
            blockchain: APP_WALLET_SWAP_CHAIN,
            tokenId: '00000000-0000-0000-0000-000000000000',
            walletId: 'circle-wallet-1',
            sourceAddress: USER_ADDRESS,
            destinationAddress: TREASURY_ADDRESS,
            transactionType: 'OUTBOUND',
            state: 'COMPLETE',
            amounts: ['1'],
            txHash: depositTxHash,
          },
        ],
      });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available from Circle yet. Retry shortly.',
    );
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('completedAt');
  });

  it('does not resolve EURC deposit txHash from a USDC tokenId candidate', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          tokenId: arcTestnetCircleUsdcTokenId,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          amount: '1',
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
  });

  it('does not resolve USDC deposit txHash from a EURC tokenId candidate', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          tokenId: arcTestnetCircleEurcTokenId,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          amount: '1',
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
  });

  it('ignores Circle list fallback entries with the wrong wallet id', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'other-wallet',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['5'],
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      amountIn: '5000000',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
  });

  it('ignores Circle list fallback entries with the wrong source address', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          tokenId: arcTestnetCircleUsdcTokenId,
          walletId: 'circle-wallet-1',
          sourceAddress: '0x1111111111111111111111111111111111111111',
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          transactionType: 'OUTBOUND',
          amounts: ['1'],
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('completedAt');
  });

  it('ignores Circle list fallback entries with the wrong state', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'PENDING',
          operation: 'TRANSFER',
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['5'],
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      amountIn: '5000000',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
  });

  it('ignores Circle list fallback entries with the wrong operation', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'CONTRACT_EXECUTION',
          transactionType: 'INBOUND',
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['5'],
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      amountIn: '5000000',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
  });

  it('ignores Circle transaction list entries with the wrong destination', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          refId: 'challenge-1',
          destinationAddress: USER_ADDRESS,
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['1000000'],
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available from Circle yet. Retry shortly.',
    );
  });

  it('ignores Circle transaction list entries with the wrong token', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          refId: 'challenge-1',
          destinationAddress: TREASURY_ADDRESS,
          tokenSymbol: 'EURC',
          amounts: ['1000000'],
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available from Circle yet. Retry shortly.',
    );
  });

  it('resolves EURC deposit txHash from Circle list when tokenSymbol matches operation tokenIn', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          tokenSymbol: 'EURC',
          amounts: ['1'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('completedAt');
  });

  it('resolves EURC deposit txHash from Circle list when tokenAddress matches operation tokenIn', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          tokenAddress: USER_SWAP_EURC_ADDRESS,
          amounts: ['1'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      depositTxHash,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    expect(result).not.toHaveProperty('depositConfirmationError');
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('resolves EURC deposit txHash when destination is null but token transfer fields match', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: null,
          state: 'COMPLETE',
          transactionType: 'OUTBOUND',
          tokenAddress: USER_SWAP_EURC_ADDRESS,
          amount: '1',
          createDate: '2026-05-17T04:55:38.005Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      amountIn: '1000000',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });
    appWalletSwapOperationStore.set(submitted.operationId, {
      ...appWalletSwapOperationStore.get(submitted.operationId)!,
      depositSubmittedAt: new Date('2026-05-17T04:55:48.005Z'),
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result).toMatchObject({
      status: 'deposit_submitted',
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      depositTxHash,
    });
    expect(result).not.toHaveProperty('depositConfirmationError');
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('persists sanitized EURC candidate shape when only an unknown tokenId is available', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          transactionType: 'OUTBOUND',
          tokenId: 'runtime-eurc-token-id',
          apiKey: 'secret-api-key',
          amounts: ['1'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result.depositConfirmationError).toContain(
      'Candidate transaction shapes:',
    );
    expect(result.depositConfirmationError).toContain('runtime-eurc-token-id');
    expect(result.depositConfirmationError).not.toContain('secret-api-key');
  });

  it('does not resolve EURC deposit txHash when destination mismatches', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: USER_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          tokenSymbol: 'EURC',
          amounts: ['1'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
  });

  it('does not resolve EURC deposit txHash when amount mismatches', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-1',
          sourceAddress: USER_ADDRESS,
          destinationAddress: TREASURY_ADDRESS,
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          tokenSymbol: 'EURC',
          amounts: ['0.999999'],
          createDate: '2099-01-01T00:00:00.000Z',
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
      circleWalletId: 'circle-wallet-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
  });

  it('ignores Circle transaction list entries with the wrong amount', async () => {
    w3sAuthService.getTransaction.mockRejectedValueOnce(
      new Error('Not found'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction-2',
          blockchain: APP_WALLET_SWAP_CHAIN,
          refId: 'challenge-1',
          destinationAddress: TREASURY_ADDRESS,
          contractAddress: '0x3600000000000000000000000000000000000000',
          amounts: ['0.999999'],
          txHash: depositTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    const result = await service.resolveDepositTxHash(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result).not.toHaveProperty('depositTxHash');
    expect(result.depositConfirmationError).toBe(
      'Deposit txHash is not available from Circle yet. Retry shortly.',
    );
  });

  it('rejects txHash resolution for non-deposit_submitted operations', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(
      service.resolveDepositTxHash(operation.operationId),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
      },
    });
    expect(w3sAuthService.getTransaction).not.toHaveBeenCalled();
  });

  it('confirms a submitted deposit when on-chain verifier succeeds', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      depositTxHash,
    });

    const result = await service.confirmDeposit(submitted.operationId);
    const persisted = await service.getOperation(operation.operationId);

    expect(depositVerifier.verifyDeposit).toHaveBeenCalledWith({
      amountIn: baseRequest.amountIn,
      depositTxHash,
      tokenIn: 'USDC',
      treasuryDepositAddress: TREASURY_ADDRESS,
      userWalletAddress: USER_ADDRESS,
    });
    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_confirmed',
      depositTxHash,
      depositConfirmedAmount: baseRequest.amountIn,
    });
    expect(persisted).toMatchObject({
      status: 'deposit_confirmed',
      depositTxHash,
      depositConfirmedAmount: baseRequest.amountIn,
    });
    expect(result.depositConfirmedAt).toEqual(expect.any(String));
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('does not confirm when deposit txHash is missing', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      circleReferenceId: 'challenge-1',
    });

    const result = await service.confirmDeposit(submitted.operationId);

    expect(depositVerifier.verifyDeposit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      operationId: operation.operationId,
      status: 'deposit_submitted',
      circleReferenceId: 'challenge-1',
    });
    expect(result.depositConfirmationError).toContain(
      'Deposit txHash is not available yet',
    );
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('rejects confirmation for non-deposit_submitted operations', async () => {
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(service.confirmDeposit(operation.operationId)).rejects.toMatchObject(
      {
        response: {
          code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        },
      },
    );
    expect(depositVerifier.verifyDeposit).not.toHaveBeenCalled();
  });

  it('confirmDeposit rejects invalid operationId before Prisma throws', async () => {
    prisma.appWalletSwapOperation.findUnique.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid'),
    );

    await expect(
      createService().confirmDeposit(invalidOperationId),
    ).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_INVALID_REQUEST',
        message: 'App Wallet swap operation id is invalid.',
      },
    });
    expect(prisma.appWalletSwapOperation.findUnique).not.toHaveBeenCalled();
    expect(depositVerifier.verifyDeposit).not.toHaveBeenCalled();
  });

  it('does not confirm failed receipts', async () => {
    depositVerifier.verifyDeposit.mockResolvedValueOnce({
      confirmed: false,
      error: 'Deposit transaction receipt is not successful.',
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      depositTxHash,
    });

    const result = await service.confirmDeposit(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result.depositConfirmationError).toBe(
      'Deposit transaction receipt is not successful.',
    );
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('keeps deposit_submitted when on-chain verifier throws', async () => {
    depositVerifier.verifyDeposit.mockRejectedValueOnce(
      new Error('Transaction not indexed'),
    );
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      depositTxHash,
    });

    const result = await service.confirmDeposit(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result.depositConfirmationError).toBe(
      'Deposit could not be verified on-chain yet. Retry after the transaction is indexed.',
    );
    expect(result).not.toHaveProperty('depositConfirmedAt');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('does not confirm wrong recipient, token, or amount verifier failures', async () => {
    depositVerifier.verifyDeposit.mockResolvedValueOnce({
      confirmed: false,
      error:
        'Deposit transaction did not include a matching USDC transfer to the treasury.',
    });
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const submitted = await service.submitDeposit(operation.operationId, {
      depositTxHash,
    });

    const result = await service.confirmDeposit(submitted.operationId);

    expect(result.status).toBe('deposit_submitted');
    expect(result.depositConfirmationError).toContain(
      'matching USDC transfer',
    );
    expect(result).not.toHaveProperty('depositConfirmedAt');
  });

  it('execute rejects non-deposit_confirmed operations', async () => {
    enableExecutionEnv();
    const service = createService();
    const operation = await service.createOperation(baseRequest);

    await expect(service.execute(operation.operationId)).rejects.toThrow(
      'App Wallet swap operation must be deposit_confirmed before execution.',
    );
    expect(userSwapService.prepare).not.toHaveBeenCalled();
    expect(circleService.executeContract).not.toHaveBeenCalled();
  });

  it('execute rejects deposit_confirmed operations without depositTxHash', async () => {
    enableExecutionEnv();
    const service = createService();
    const operation = await service.createOperation(baseRequest);
    const record = appWalletSwapOperationStore.get(operation.operationId)!;
    appWalletSwapOperationStore.set(operation.operationId, {
      ...record,
      status: 'deposit_confirmed',
      depositTxHash: null,
      depositConfirmedAt: new Date(),
      depositConfirmedAmount: baseRequest.amountIn,
    });

    await expect(service.execute(operation.operationId)).rejects.toThrow(
      'App Wallet swap operation requires a verified deposit txHash before execution.',
    );
    expect(circleService.executeContract).not.toHaveBeenCalled();
  });

  it('execute rejects missing treasury execution config', async () => {
    enableExecutionEnv();
    const service = createService();
    const operation = await createConfirmedOperation(service);
    delete process.env.CIRCLE_API_KEY;

    await expect(service.execute(operation.operationId)).rejects.toMatchObject({
      response: {
        code: 'APP_WALLET_SWAP_TREASURY_NOT_CONFIGURED',
      },
    });
    expect(circleService.executeContract).not.toHaveBeenCalled();
  });

  it('execute rejects old operations created while execution was disabled', async () => {
    const service = createService();
    const operation = await createConfirmedOperation(service);
    enableExecutionEnv();

    await expect(service.execute(operation.operationId)).rejects.toThrow(
      'App Wallet swap operation was created while treasury execution was disabled.',
    );
    expect(circleService.executeContract).not.toHaveBeenCalled();
  });

  it('execute submits treasury swap and payout once, then completes', async () => {
    enableExecutionEnv();
    const service = createService();
    const operation = await createConfirmedOperation(service);

    const result = await service.execute(operation.operationId);
    const repeated = await service.execute(operation.operationId);

    expect(userSwapService.prepare).toHaveBeenCalledTimes(1);
    expect(circleService.executeContract).toHaveBeenCalledTimes(1);
    expect(circleService.transfer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'completed',
      treasurySwapId: 'treasury-swap-transaction-1',
      treasurySwapActualOutput: '990000',
      payoutAmount: '990000',
      payoutTxHash:
        '0xcc019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5',
    });
    expect(repeated.status).toBe('completed');
    expect(repeated).toHaveProperty('completedAt');
    expect(repeated).not.toHaveProperty('settledAt');
  });

  it('execute supports EURC to USDC treasury swap and USDC payout', async () => {
    enableExecutionEnv();
    userSwapService.prepare.mockResolvedValueOnce({
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      amountIn: baseRequest.amountIn,
      fromAddress: TREASURY_ADDRESS,
      toAddress: TREASURY_ADDRESS,
      chain: APP_WALLET_SWAP_CHAIN,
      expectedOutput: '980000',
      minimumOutput: '960000',
      transaction: {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        raw: { to: '0x1111111111111111111111111111111111111111' },
      },
      raw: { quoteId: 'treasury-quote-eurc-usdc' },
    });
    treasuryVerifier.verifyTreasurySwap.mockResolvedValueOnce({
      confirmed: true,
      actualOutput: '980000',
    });
    const service = createService();
    const operation = await service.createOperation({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    const submitted = await service.submitDeposit(operation.operationId, {
      depositTxHash,
    });
    const confirmed = await service.confirmDeposit(submitted.operationId);

    const result = await service.execute(confirmed.operationId);

    expect(userSwapService.prepare).toHaveBeenCalledWith({
      amountIn: baseRequest.amountIn,
      chain: APP_WALLET_SWAP_CHAIN,
      fromAddress: TREASURY_ADDRESS,
      toAddress: TREASURY_ADDRESS,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });
    expect(treasuryVerifier.verifyTreasurySwap).toHaveBeenCalledWith({
      txHash:
        '0xaa019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5',
      tokenOut: 'USDC',
      treasuryAddress: TREASURY_ADDRESS,
      minimumOutput: expect.any(String),
    });
    expect(circleService.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'USDC',
        toAddress: USER_ADDRESS,
        amount: '0.98',
      }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      payoutAmount: '980000',
    });
  });

  it('persists sanitized treasury swap prepare response before non-executable response failure', async () => {
    enableExecutionEnv();
    userSwapService.prepare.mockResolvedValueOnce({
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: baseRequest.amountIn,
      fromAddress: TREASURY_ADDRESS,
      toAddress: TREASURY_ADDRESS,
      chain: APP_WALLET_SWAP_CHAIN,
      expectedOutput: '990000',
      minimumOutput: '970000',
      transaction: {
        raw: {
          signature: '0x1234',
        },
      },
      raw: {
        amount: baseRequest.amountIn,
        apiKey: 'secret-api-key',
        transaction: {
          signature: '0x1234',
        },
      },
    });
    const service = createService();
    const operation = await createConfirmedOperation(service);

    const result = await service.execute(operation.operationId);

    expect(result.status).toBe('execution_failed');
    expect(result.executionError).toContain(
      'Circle Stablecoin Kits swap response did not include an executable transaction target.',
    );
    expect(result.executionError).toContain('Top-level keys: amount, apiKey, transaction');
    expect(result.executionError).toContain('Transaction keys: signature');
    expect(result.rawTreasurySwap).toMatchObject({
      prepare: {
        amount: baseRequest.amountIn,
        apiKey: '[REDACTED]',
        transaction: {
          signature: '0x1234',
        },
      },
    });
    expect(circleService.executeContract).not.toHaveBeenCalled();
    expect(circleService.getTransactionStatus).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
  });

  it('normalizes hex quantity instruction values without dropping zero-value instructions', () => {
    const service = createService() as unknown as {
      buildSwapExecuteParams: (executionParams: Record<string, unknown>) => {
        instructions: Array<{ value: bigint }>;
      };
    };

    const result = service.buildSwapExecuteParams({
      instructions: [
        {
          target: '0x1111111111111111111111111111111111111111',
          data: '0x1234',
          value: '0',
          tokenIn: '0x3600000000000000000000000000000000000000',
          amountToApprove: '1000000',
          tokenOut: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
          minTokenOut: '900000',
        },
        {
          target: '0x2222222222222222222222222222222222222222',
          data: '0xabcd',
          value: '0x0',
          tokenIn: '0x3600000000000000000000000000000000000000',
          amountToApprove: '0x0',
          tokenOut: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
          minTokenOut: '0xde0b6b3a7640000',
        },
      ],
      tokens: [],
      execId: '1',
      deadline: '0x1',
      metadata: '0x',
    });

    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[0].value).toBe(0n);
    expect(result.instructions[1].value).toBe(0n);
  });

  it('execute does not payout before treasury swap confirmation', async () => {
    enableExecutionEnv();
    treasuryVerifier.verifyTreasurySwap.mockResolvedValueOnce({
      confirmed: false,
      error: 'Treasury swap transaction is not indexed yet.',
    });
    const service = createService();
    const operation = await createConfirmedOperation(service);

    const result = await service.execute(operation.operationId);

    expect(result.status).toBe('treasury_swap_submitted');
    expect(circleService.executeContract).toHaveBeenCalledTimes(1);
    expect(circleService.transfer).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('completedAt');
  });

  it('execute resumes submitted treasury swap without duplicate submission', async () => {
    enableExecutionEnv();
    treasuryVerifier.verifyTreasurySwap
      .mockResolvedValueOnce({
        confirmed: false,
        error: 'Treasury swap transaction is not indexed yet.',
      })
      .mockResolvedValueOnce({
        confirmed: true,
        actualOutput: '990000',
      });
    const service = createService();
    const operation = await createConfirmedOperation(service);

    const first = await service.execute(operation.operationId);
    const second = await service.execute(first.operationId);

    expect(first.status).toBe('treasury_swap_submitted');
    expect(second.status).toBe('completed');
    expect(circleService.executeContract).toHaveBeenCalledTimes(1);
    expect(circleService.transfer).toHaveBeenCalledTimes(1);
  });

  it('keeps payout_submitted when payout status is queued and no txHash is found', async () => {
    enableExecutionEnv();
    circleService.getTransactionStatus.mockResolvedValueOnce({
      txId: 'payout-transaction-queued',
      status: 'QUEUED',
      txHash: null,
      blockNumber: null,
      errorReason: null,
    });
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [],
    });
    const service = createService();
    const operation = await createPayoutSubmittedOperation(service);

    const result = await service.execute(operation.operationId);

    expect(result).toMatchObject({
      status: 'payout_submitted',
      payoutAmount: '1042878',
    });
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('completedAt');
    expect(circleService.executeContract).not.toHaveBeenCalled();
    expect(circleService.transfer).not.toHaveBeenCalled();
  });

  it('marks payout_submitted completed when Circle direct status later returns txHash', async () => {
    enableExecutionEnv();
    const payoutTxHash =
      '0xdd019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
    circleService.getTransactionStatus.mockResolvedValueOnce({
      txId: 'payout-transaction-queued',
      status: 'COMPLETE',
      txHash: payoutTxHash,
      blockNumber: '10',
      errorReason: null,
    });
    const service = createService();
    const operation = await createPayoutSubmittedOperation(service);

    const result = await service.execute(operation.operationId);

    expect(result).toMatchObject({
      status: 'completed',
      payoutTxHash,
    });
    expect(result).not.toHaveProperty('executionError');
    expect(result.payoutConfirmedAt).toEqual(expect.any(String));
    expect(result.completedAt).toEqual(expect.any(String));
    expect(circleService.transfer).not.toHaveBeenCalled();
    expect(w3sAuthService.listTransactions).not.toHaveBeenCalled();
  });

  it('falls back to Circle W3S transaction list when direct payout lookup is not accessible', async () => {
    enableExecutionEnv();
    const payoutTxHash =
      '0xee019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
    circleService.getTransactionStatus.mockRejectedValueOnce(
      new Error('Cannot find target transaction in the system.'),
    );
    w3sAuthService.listTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'payout-transaction-queued',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'circle-wallet-arc-1',
          sourceAddress: TREASURY_ADDRESS,
          destinationAddress: USER_ADDRESS,
          tokenSymbol: 'EURC',
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          amount: '1.042878',
          createDate: '2026-05-17T01:01:00.000Z',
          txHash: payoutTxHash,
        },
      ],
    });
    const service = createService();
    const operation = await createPayoutSubmittedOperation(service);

    const result = await service.execute(operation.operationId);

    expect(w3sAuthService.listTransactions).toHaveBeenCalledWith({
      walletIds: 'circle-wallet-arc-1',
    });
    expect(result).toMatchObject({
      status: 'completed',
      payoutTxHash,
    });
    expect(result).not.toHaveProperty('executionError');
    expect(result.payoutConfirmedAt).toEqual(expect.any(String));
    expect(result.completedAt).toEqual(expect.any(String));
    expect(circleService.transfer).not.toHaveBeenCalled();
  });

  it('execute persists execution_failed and preserves prior identifiers', async () => {
    enableExecutionEnv();
    circleService.transfer.mockRejectedValueOnce(new Error('Payout unavailable'));
    const service = createService();
    const operation = await createConfirmedOperation(service);

    const result = await service.execute(operation.operationId);

    expect(result).toMatchObject({
      status: 'execution_failed',
      treasurySwapId: 'treasury-swap-transaction-1',
      treasurySwapActualOutput: '990000',
      executionError: 'Payout unavailable',
    });
    expect(result).not.toHaveProperty('completedAt');
  });
});

