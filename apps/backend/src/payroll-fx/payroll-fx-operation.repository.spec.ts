import { MODULE_METADATA } from '@nestjs/common/constants';
import {
  PayrollFxExecutionProvider as PrismaExecutionProvider,
  PayrollFxOperation as PrismaPayrollFxOperation,
  PayrollFxOperationStatus as PrismaOperationStatus,
  PayrollFxWalletMode as PrismaWalletMode,
  Prisma,
} from '@prisma/client';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import {
  PayrollFxOperationIntentConflictError,
  PayrollFxOperationStateConflictError,
  PayrollFxOperationTaskConflictError,
  PayrollFxOperationValidationError,
} from './payroll-fx-operation.errors';
import {
  mapPayrollFxOperation,
  normalizePayrollFxIntent,
  toBoundedDiagnosticJson,
} from './payroll-fx-operation.mapper';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import { PayrollFxModule } from './payroll-fx.module';
import { PayrollFxOperationIntent } from './payroll-fx-operation.types';

const OPERATION_ID = '8d00c7ac-d036-4448-94ea-2f38a51e64d8';
const TASK_ID = 'f8d10929-7c47-4d98-a811-6ba682b057d0';
const CREATED_AT = new Date('2026-07-27T08:00:00.000Z');

function createIntent(
  overrides: Partial<PayrollFxOperationIntent> = {},
): PayrollFxOperationIntent {
  return {
    idempotencyKey: 'payroll-fx-idempotency-1',
    walletMode: 'app',
    executionProvider: 'stablefx',
    sourceTokenAddress: '0x3600000000000000000000000000000000000000',
    destinationTokenAddress: '0x89b50855aa3be2f677cd6303cec089b5f319d72a',
    sourceTokenSymbol: 'USDC',
    destinationTokenSymbol: 'EURC',
    network: 'ARC-TESTNET',
    sourceWalletAddress: '0x1111111111111111111111111111111111111111',
    treasuryWalletAddress: '0x2222222222222222222222222222222222222222',
    amountInBaseUnits: '30000000',
    requestedMinimumOutputBaseUnits: '29000000',
    ...overrides,
  };
}

function createRecord(
  overrides: Partial<PrismaPayrollFxOperation> = {},
): PrismaPayrollFxOperation {
  return {
    operationId: OPERATION_ID,
    idempotencyKey: 'payroll-fx-idempotency-1',
    taskId: null,
    walletMode: PrismaWalletMode.APP,
    executionProvider: PrismaExecutionProvider.STABLEFX,
    sourceTokenAddress: '0x3600000000000000000000000000000000000000',
    destinationTokenAddress: '0x89b50855aa3be2f677cd6303cec089b5f319d72a',
    sourceTokenSymbol: 'USDC',
    destinationTokenSymbol: 'EURC',
    network: 'ARC-TESTNET',
    sourceWalletAddress: '0x1111111111111111111111111111111111111111',
    treasuryWalletAddress: '0x2222222222222222222222222222222222222222',
    amountInBaseUnits: '30000000',
    requestedMinimumOutputBaseUnits: '29000000',
    status: PrismaOperationStatus.CREATED,
    failureCode: null,
    failureMessage: null,
    quoteId: null,
    quoteExpiresAt: null,
    expectedOutputBaseUnits: null,
    actualOutputBaseUnits: null,
    providerOperationId: null,
    approvalTransactionId: null,
    approvalTransactionHash: null,
    fundingTransactionId: null,
    fundingTransactionHash: null,
    settlementTransactionId: null,
    settlementTransactionHash: null,
    payoutTransactionId: null,
    payoutTransactionHash: null,
    lastProviderStatus: null,
    diagnosticSnapshot: null,
    submittedAt: null,
    fundingConfirmedAt: null,
    settledAt: null,
    payoutConfirmedAt: null,
    completedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    payrollFxOperation: {
      create: jest.fn<
        Promise<PrismaPayrollFxOperation>,
        [Prisma.PayrollFxOperationCreateArgs]
      >(),
      findUnique: jest.fn<
        Promise<PrismaPayrollFxOperation | null>,
        [Prisma.PayrollFxOperationFindUniqueArgs]
      >(),
      updateMany: jest.fn<
        Promise<{ count: number }>,
        [Prisma.PayrollFxOperationUpdateManyArgs]
      >(),
    },
  };
}

describe('PayrollFxOperationRepository', () => {
  it('is registered through the standalone Payroll FX module', () => {
    const providers: unknown = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PayrollFxModule,
    );
    const imports: unknown = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    );

    expect(Array.isArray(providers) ? providers : []).toContain(
      PayrollFxOperationRepository,
    );
    expect(Array.isArray(imports) ? imports : []).toContain(PayrollFxModule);
  });

  it.each([
    ['stablefx', PrismaExecutionProvider.STABLEFX],
    ['swapkit', PrismaExecutionProvider.SWAPKIT],
  ] as const)(
    'creates and maps a %s operation without a Payroll task',
    async (provider, prismaProvider) => {
      const prisma = createPrismaMock();
      const record = createRecord({ executionProvider: prismaProvider });
      prisma.payrollFxOperation.create.mockResolvedValue(record);
      const repository = new PayrollFxOperationRepository(
        prisma as unknown as PrismaService,
      );

      await expect(
        repository.create(createIntent({ executionProvider: provider })),
      ).resolves.toEqual(
        expect.objectContaining({
          executionProvider: provider,
          taskId: null,
        }),
      );
      const createData = prisma.payrollFxOperation.create.mock.calls[0][0]
        .data as Prisma.PayrollFxOperationCreateInput;
      expect(createData.operationId).toEqual(expect.any(String));
      expect(createData.idempotencyKey).toBe('payroll-fx-idempotency-1');
      expect(createData.walletMode).toBe(PrismaWalletMode.APP);
      expect(createData.executionProvider).toBe(prismaProvider);
      expect(createData).not.toHaveProperty('task');
    },
  );

  it('round-trips exact large integer base-unit strings without Number conversion', async () => {
    const amount = '900719925474099312345678901234567890';
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.create.mockResolvedValue(
      createRecord({ amountInBaseUnits: amount }),
    );
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    const result = await repository.create(
      createIntent({ amountInBaseUnits: amount }),
    );

    expect(result.amountInBaseUnits).toBe(amount);
    expect(
      prisma.payrollFxOperation.create.mock.calls[0][0].data.amountInBaseUnits,
    ).toBe(amount);
  });

  it.each([
    ['null provider', { executionProvider: null }],
    ['unknown provider', { executionProvider: 'unknown' }],
    [
      'equal token addresses',
      {
        destinationTokenAddress: '0x3600000000000000000000000000000000000000',
      },
    ],
    ['equal token symbols', { destinationTokenSymbol: 'USDC' }],
    ['zero amount', { amountInBaseUnits: '0' }],
    ['negative amount', { amountInBaseUnits: '-1' }],
    ['fractional amount', { amountInBaseUnits: '1.5' }],
  ])('rejects invalid immutable intent: %s', async (_, overrides) => {
    const prisma = createPrismaMock();
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.create(
        createIntent(overrides as Partial<PayrollFxOperationIntent>),
      ),
    ).rejects.toBeInstanceOf(PayrollFxOperationValidationError);
    expect(prisma.payrollFxOperation.create).not.toHaveBeenCalled();
  });

  it('normalizes equivalent address, symbol, and network casing', () => {
    const normalized = normalizePayrollFxIntent(
      createIntent({
        sourceTokenSymbol: 'usdc',
        destinationTokenSymbol: 'eurc',
        network: 'arc-testnet',
        sourceWalletAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    );

    expect(normalized).toMatchObject({
      sourceTokenSymbol: 'USDC',
      destinationTokenSymbol: 'EURC',
      network: 'ARC-TESTNET',
      sourceWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('returns the existing operation for an equivalent idempotent replay', async () => {
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.create.mockRejectedValue({ code: 'P2002' });
    prisma.payrollFxOperation.findUnique.mockResolvedValue(createRecord());
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.createOrGetByIdempotencyKey(createIntent()),
    ).resolves.toEqual(expect.objectContaining({ operationId: OPERATION_ID }));
  });

  it.each([
    ['provider', { executionProvider: 'swapkit' }],
    ['amount', { amountInBaseUnits: '40000000' }],
    [
      'source token',
      { sourceTokenAddress: '0x4444444444444444444444444444444444444444' },
    ],
    [
      'wallet',
      { sourceWalletAddress: '0x3333333333333333333333333333333333333333' },
    ],
    ['network', { network: 'ANOTHER-NETWORK' }],
  ])('fails closed for conflicting replay intent: %s', async (_, overrides) => {
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.create.mockRejectedValue({ code: 'P2002' });
    prisma.payrollFxOperation.findUnique.mockResolvedValue(createRecord());
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.createOrGetByIdempotencyKey(
        createIntent(overrides as Partial<PayrollFxOperationIntent>),
      ),
    ).rejects.toBeInstanceOf(PayrollFxOperationIntentConflictError);
  });

  it('attaches a task once and accepts an idempotent repeat', async () => {
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.payrollFxOperation.findUnique.mockResolvedValue(
      createRecord({ taskId: TASK_ID }),
    );
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(repository.attachTask(OPERATION_ID, TASK_ID)).resolves.toEqual(
      expect.objectContaining({ taskId: TASK_ID }),
    );
    await expect(repository.attachTask(OPERATION_ID, TASK_ID)).resolves.toEqual(
      expect.objectContaining({ taskId: TASK_ID }),
    );
  });

  it('does not silently replace an attached task', async () => {
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.updateMany.mockResolvedValue({ count: 0 });
    prisma.payrollFxOperation.findUnique.mockResolvedValue(
      createRecord({ taskId: '816f448f-f0b6-4164-b1fd-d825c352ff1a' }),
    );
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.attachTask(OPERATION_ID, TASK_ID),
    ).rejects.toBeInstanceOf(PayrollFxOperationTaskConflictError);
  });

  it('updates lifecycle evidence only from the expected current state', async () => {
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.payrollFxOperation.findUnique.mockResolvedValue(
      createRecord({
        status: PrismaOperationStatus.QUOTE_READY,
        quoteId: 'quote-1',
        expectedOutputBaseUnits: '29750001',
      }),
    );
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.recordQuote(OPERATION_ID, 'created', {
        quoteId: 'quote-1',
        expectedOutputBaseUnits: '29750001',
        diagnosticSnapshot: { providerStatus: 'quoted' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'quote_ready',
        expectedOutputBaseUnits: '29750001',
      }),
    );
    const updateCall = prisma.payrollFxOperation.updateMany.mock.calls[0][0];
    expect(updateCall.where).toEqual({
      operationId: OPERATION_ID,
      status: PrismaOperationStatus.CREATED,
    });
    expect(updateCall.data).toMatchObject({
      status: PrismaOperationStatus.QUOTE_READY,
      quoteId: 'quote-1',
      expectedOutputBaseUnits: '29750001',
      diagnosticSnapshot: { providerStatus: 'quoted' },
    });
  });

  it('rejects a stale lifecycle update', async () => {
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.updateMany.mockResolvedValue({ count: 0 });
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.recordSubmission(OPERATION_ID, 'quote_ready', {
        providerOperationId: 'trade-1',
        submittedAt: CREATED_AT,
      }),
    ).rejects.toBeInstanceOf(PayrollFxOperationStateConflictError);
    expect(prisma.payrollFxOperation.findUnique).not.toHaveBeenCalled();
  });

  it('round-trips exact settlement and payout transaction evidence', async () => {
    const prisma = createPrismaMock();
    prisma.payrollFxOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.payrollFxOperation.findUnique
      .mockResolvedValueOnce(
        createRecord({
          status: PrismaOperationStatus.SETTLED,
          actualOutputBaseUnits: '90071992547409931234567890',
          settlementTransactionHash: `0x${'a'.repeat(64)}`,
          settledAt: CREATED_AT,
        }),
      )
      .mockResolvedValueOnce(
        createRecord({
          status: PrismaOperationStatus.COMPLETED,
          payoutTransactionHash: `0x${'b'.repeat(64)}`,
          payoutConfirmedAt: CREATED_AT,
          completedAt: CREATED_AT,
        }),
      );
    const repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.recordSettlement(OPERATION_ID, 'settlement_pending', {
        actualOutputBaseUnits: '90071992547409931234567890',
        settlementTransactionHash: `0x${'a'.repeat(64)}`,
        settledAt: CREATED_AT,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        actualOutputBaseUnits: '90071992547409931234567890',
      }),
    );
    await expect(
      repository.recordPayout(OPERATION_ID, 'payout_pending', {
        payoutTransactionHash: `0x${'b'.repeat(64)}`,
        payoutConfirmedAt: CREATED_AT,
        completedAt: CREATED_AT,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        payoutTransactionHash: `0x${'b'.repeat(64)}`,
        status: 'completed',
      }),
    );
  });

  it('accepts bounded diagnostic JSON and rejects secret-bearing or oversized data', () => {
    expect(
      toBoundedDiagnosticJson({
        providerStatus: 'pending',
        traceId: 'safe-trace-id',
      }),
    ).toEqual({
      providerStatus: 'pending',
      traceId: 'safe-trace-id',
    });
    expect(() =>
      toBoundedDiagnosticJson({ authorization: 'Bearer secret' }),
    ).toThrow(PayrollFxOperationValidationError);
    expect(() =>
      toBoundedDiagnosticJson({ message: 'x'.repeat(16_384) }),
    ).toThrow(PayrollFxOperationValidationError);
  });

  it('maps all persisted evidence without exposing a Prisma update surface', () => {
    const mapped = mapPayrollFxOperation(
      createRecord({
        diagnosticSnapshot: { status: 'safe' },
        providerOperationId: 'provider-operation-1',
      }),
    );

    expect(mapped).toMatchObject({
      executionProvider: 'stablefx',
      status: 'created',
      diagnosticSnapshot: { status: 'safe' },
      providerOperationId: 'provider-operation-1',
    });
    expect(
      (
        PayrollFxOperationRepository.prototype as unknown as Record<
          string,
          unknown
        >
      ).update,
    ).toBeUndefined();
  });
});
