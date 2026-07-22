import { AppWalletSwapOperation, Prisma } from '@prisma/client';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PrismaService } from '../database/prisma.service';
import { AppWalletSwapModule } from './app-wallet-swap.module';
import {
  mapAppWalletSwapOperationRecord,
  toPublicAppWalletSwapOperation,
} from './app-wallet-swap-operation.mapper';
import {
  AppWalletSwapOperationRepository,
  toAppWalletSwapNullableJson,
} from './app-wallet-swap-operation.repository';
import { AppWalletSwapOperationResponse } from './app-wallet-swap.types';

const OPERATION_ID = '8d00c7ac-d036-4448-94ea-2f38a51e64d8';
const OTHER_OPERATION_ID = 'f8d10929-7c47-4d98-a811-6ba682b057d0';
const CREATED_AT = '2026-07-20T10:00:00.000Z';
const UPDATED_AT = '2026-07-20T10:01:00.000Z';

function createOperation(
  overrides: Partial<AppWalletSwapOperationResponse> = {},
): AppWalletSwapOperationResponse {
  return {
    operationId: OPERATION_ID,
    operationMode: 'treasury-mediated',
    sourceChain: 'ARC-TESTNET',
    tokenIn: 'EURC',
    tokenOut: 'USDC',
    amountIn: '1000000',
    userWalletAddress: '0x1111111111111111111111111111111111111111',
    treasuryDepositAddress: '0x2222222222222222222222222222222222222222',
    expectedOutput: null,
    minimumOutput: '990000',
    expiresAt: '2026-07-20T10:05:00.000Z',
    status: 'deposit_submitted',
    quoteId: 'quote-synthetic-1',
    rawQuote: { provider: 'stablefx', quoteId: 'quote-synthetic-1' },
    circleWalletId: 'wallet-synthetic-1',
    circleTransactionId: 'transaction-synthetic-1',
    circleReferenceId: 'reference-synthetic-1',
    depositSubmittedAt: '2026-07-20T10:00:30.000Z',
    executionEnabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function createRecord(
  overrides: Partial<AppWalletSwapOperation> = {},
): AppWalletSwapOperation {
  return {
    operationId: OPERATION_ID,
    operationMode: 'treasury-mediated',
    sourceChain: 'ARC-TESTNET',
    tokenIn: 'EURC',
    tokenOut: 'USDC',
    amountIn: '1000000',
    userWalletAddress: '0x1111111111111111111111111111111111111111',
    treasuryDepositAddress: '0x2222222222222222222222222222222222222222',
    expectedOutput: null,
    minimumOutput: '990000',
    expiresAt: '2026-07-20T10:05:00.000Z',
    status: 'deposit_submitted',
    quoteId: 'quote-synthetic-1',
    rawQuote: { provider: 'stablefx', quoteId: 'quote-synthetic-1' },
    depositTxHash: null,
    circleTransactionId: 'transaction-synthetic-1',
    circleReferenceId: 'reference-synthetic-1',
    circleWalletId: 'wallet-synthetic-1',
    depositSubmittedAt: new Date('2026-07-20T10:00:30.000Z'),
    depositConfirmedAt: null,
    depositConfirmedAmount: null,
    depositConfirmationError: null,
    executionEnabled: true,
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
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    completedAt: null,
    executionError: null,
    createdAt: new Date(CREATED_AT),
    updatedAt: new Date(UPDATED_AT),
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    appWalletSwapOperation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

describe('AppWalletSwapOperationRepository', () => {
  it('is registered in the App Wallet swap module', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppWalletSwapModule,
    );

    expect(providers).toContain(AppWalletSwapOperationRepository);
  });

  it('creates an operation with the exact persistence mapping', async () => {
    const prisma = createPrismaMock();
    const record = createRecord();
    prisma.appWalletSwapOperation.create.mockResolvedValue(record);
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );
    const operation = createOperation({
      rawTreasurySwap: { provider: 'stablefx', status: 'pending' },
      depositConfirmedAmount: '1000000',
    });

    await expect(repository.create(operation)).resolves.toBe(record);
    expect(prisma.appWalletSwapOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationId: OPERATION_ID,
        amountIn: '1000000',
        expectedOutput: Prisma.JsonNull,
        minimumOutput: '990000',
        rawQuote: operation.rawQuote,
        rawTreasurySwap: operation.rawTreasurySwap,
        circleWalletId: 'wallet-synthetic-1',
        circleTransactionId: 'transaction-synthetic-1',
        circleReferenceId: 'reference-synthetic-1',
        depositSubmittedAt: new Date('2026-07-20T10:00:30.000Z'),
        depositConfirmedAt: undefined,
        depositConfirmedAmount: '1000000',
        createdAt: new Date(CREATED_AT),
        updatedAt: new Date(UPDATED_AT),
      }),
    });
    expect(operation).toEqual(
      createOperation({
        rawTreasurySwap: { provider: 'stablefx', status: 'pending' },
        depositConfirmedAmount: '1000000',
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves explicit JSON null and non-null JSON values', () => {
    expect(toAppWalletSwapNullableJson(undefined)).toBe(Prisma.JsonNull);
    expect(toAppWalletSwapNullableJson(null)).toBe(Prisma.JsonNull);
    expect(toAppWalletSwapNullableJson({ status: 'pending' })).toEqual({
      status: 'pending',
    });
  });

  it('finds by the canonical operationId and preserves a missing result', async () => {
    const prisma = createPrismaMock();
    prisma.appWalletSwapOperation.findUnique
      .mockResolvedValueOnce(createRecord())
      .mockResolvedValueOnce(null);
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(repository.findById(OPERATION_ID)).resolves.toEqual(
      createRecord(),
    );
    await expect(repository.findById(OTHER_OPERATION_ID)).resolves.toBeNull();
    expect(prisma.appWalletSwapOperation.findUnique).toHaveBeenNthCalledWith(
      1,
      { where: { operationId: OPERATION_ID } },
    );
    expect(prisma.appWalletSwapOperation.findUnique).toHaveBeenNthCalledWith(
      2,
      { where: { operationId: OTHER_OPERATION_ID } },
    );
  });

  it('passes partial updates through without mutation or inferred lifecycle fields', async () => {
    const prisma = createPrismaMock();
    const record = createRecord({ executionError: 'Synthetic failure.' });
    prisma.appWalletSwapOperation.update.mockResolvedValue(record);
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );
    const data = {
      executionError: 'Synthetic failure.',
      rawPayout: Prisma.JsonNull,
      payoutTxHash: undefined,
    };
    const original = { ...data };

    await expect(repository.update(OPERATION_ID, data)).resolves.toBe(record);
    expect(prisma.appWalletSwapOperation.update).toHaveBeenCalledWith({
      where: { operationId: OPERATION_ID },
      data,
    });
    expect(data).toEqual(original);
    expect(data).not.toHaveProperty('status');
  });

  it('propagates create, read, update, and lease persistence errors unchanged', async () => {
    const prisma = createPrismaMock();
    const failure = new Error('Synthetic persistence failure.');
    prisma.appWalletSwapOperation.create.mockRejectedValue(failure);
    prisma.appWalletSwapOperation.findUnique.mockRejectedValue(failure);
    prisma.appWalletSwapOperation.update.mockRejectedValue(failure);
    prisma.appWalletSwapOperation.updateMany.mockRejectedValue(failure);
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(repository.create(createOperation())).rejects.toBe(failure);
    await expect(repository.findById(OPERATION_ID)).rejects.toBe(failure);
    await expect(repository.update(OPERATION_ID, {})).rejects.toBe(failure);
    await expect(
      repository.claimExecutionLease(
        OPERATION_ID,
        'lease-1',
        new Date(CREATED_AT),
        new Date(UPDATED_AT),
      ),
    ).rejects.toBe(failure);
  });

  it.each([
    ['one affected row', 1, true],
    ['no affected rows', 0, false],
    ['unexpected multiple rows', 2, false],
  ])('derives claim success from %s', async (_, count, expected) => {
    const prisma = createPrismaMock();
    prisma.appWalletSwapOperation.updateMany.mockResolvedValue({ count });
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.claimExecutionLease(
        OPERATION_ID,
        'lease-1',
        new Date(CREATED_AT),
        new Date(UPDATED_AT),
      ),
    ).resolves.toBe(expected);
  });

  it('uses the exact lease claim predicate and supplied owner and timestamps', async () => {
    const prisma = createPrismaMock();
    prisma.appWalletSwapOperation.updateMany.mockResolvedValue({ count: 1 });
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );
    const now = new Date(CREATED_AT);
    const expiresAt = new Date(UPDATED_AT);

    await repository.claimExecutionLease(
      OPERATION_ID,
      'lease-owner-1',
      now,
      expiresAt,
    );

    expect(prisma.appWalletSwapOperation.updateMany).toHaveBeenCalledWith({
      where: {
        operationId: OPERATION_ID,
        OR: [
          { executionLeaseId: null },
          { executionLeaseExpiresAt: null },
          { executionLeaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        executionLeaseId: 'lease-owner-1',
        executionLeaseExpiresAt: expiresAt,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves strict expiry behavior at and around the exact boundary', async () => {
    const now = new Date(CREATED_AT);
    const states = [
      { expiresAt: null, claimable: true },
      { expiresAt: new Date(now.getTime() - 1), claimable: true },
      { expiresAt: new Date(now), claimable: false },
      { expiresAt: new Date(now.getTime() + 1), claimable: false },
    ];

    for (const state of states) {
      const prisma = createPrismaMock();
      prisma.appWalletSwapOperation.updateMany.mockImplementation(({ where }) =>
        Promise.resolve({
          count:
            state.expiresAt === null ||
            state.expiresAt < where.OR[2].executionLeaseExpiresAt.lt
              ? 1
              : 0,
        }),
      );
      const repository = new AppWalletSwapOperationRepository(
        prisma as unknown as PrismaService,
      );

      await expect(
        repository.claimExecutionLease(
          OPERATION_ID,
          'lease-owner-1',
          now,
          new Date(UPDATED_AT),
        ),
      ).resolves.toBe(state.claimable);
    }
  });

  it('allows only one of two competing claims for the same operation', async () => {
    const prisma = createPrismaMock();
    const owners = new Map<string, string | null>([[OPERATION_ID, null]]);
    prisma.appWalletSwapOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        const owner = owners.get(where.operationId);
        if (owner) {
          return Promise.resolve({ count: 0 });
        }
        owners.set(where.operationId, data.executionLeaseId);
        return Promise.resolve({ count: 1 });
      },
    );
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );
    const now = new Date(CREATED_AT);

    const results = await Promise.all([
      repository.claimExecutionLease(
        OPERATION_ID,
        'lease-owner-1',
        now,
        new Date(UPDATED_AT),
      ),
      repository.claimExecutionLease(
        OPERATION_ID,
        'lease-owner-2',
        now,
        new Date(UPDATED_AT),
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(owners.get(OPERATION_ID)).toBe('lease-owner-1');
    expect(owners.has(OTHER_OPERATION_ID)).toBe(false);
  });

  it('releases only the supplied owner and clears exactly the lease fields', async () => {
    const prisma = createPrismaMock();
    prisma.appWalletSwapOperation.updateMany.mockResolvedValue({ count: 1 });
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );

    await repository.releaseExecutionLease(OPERATION_ID, 'lease-owner-1');

    expect(prisma.appWalletSwapOperation.updateMany).toHaveBeenCalledWith({
      where: {
        operationId: OPERATION_ID,
        executionLeaseId: 'lease-owner-1',
      },
      data: { executionLeaseId: null, executionLeaseExpiresAt: null },
    });
  });

  it('cannot clear a newer owner lease from a stale or already-cleared attempt', async () => {
    const prisma = createPrismaMock();
    let owner: string | null = 'lease-owner-new';
    prisma.appWalletSwapOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        if (owner !== where.executionLeaseId) {
          return Promise.resolve({ count: 0 });
        }
        owner = data.executionLeaseId;
        return Promise.resolve({ count: 1 });
      },
    );
    const repository = new AppWalletSwapOperationRepository(
      prisma as unknown as PrismaService,
    );

    await repository.releaseExecutionLease(OPERATION_ID, 'lease-owner-old');
    expect(owner).toBe('lease-owner-new');
    await repository.releaseExecutionLease(OPERATION_ID, 'lease-owner-new');
    expect(owner).toBeNull();
    await repository.releaseExecutionLease(OPERATION_ID, 'lease-owner-new');
    expect(owner).toBeNull();
  });

  it('maps persistence records identically and keeps public mapping secured', () => {
    const record = createRecord({
      depositConfirmedAmount: '1000000',
      rawTreasurySwap: {
        provider: 'stablefx',
        authorizationPayload: '[synthetic-authorization-payload]',
      },
      rawPayout: { rawCircleResponse: { status: 'synthetic' } },
    });

    const operation = mapAppWalletSwapOperationRecord(record, 'stablefx');
    const publicOperation = toPublicAppWalletSwapOperation(operation);

    expect(operation).toMatchObject({
      operationId: OPERATION_ID,
      provider: 'stablefx',
      amountIn: '1000000',
      depositConfirmedAmount: '1000000',
      circleWalletId: 'wallet-synthetic-1',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    expect(publicOperation).not.toHaveProperty('rawQuote');
    expect(publicOperation).not.toHaveProperty('rawTreasurySwap');
    expect(publicOperation).not.toHaveProperty('rawPayout');
    expect(JSON.stringify(publicOperation)).not.toContain('authorization');
  });
});
