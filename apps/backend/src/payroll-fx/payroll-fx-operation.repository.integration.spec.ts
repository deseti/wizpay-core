import {
  PayrollFxExecutionProvider as PrismaExecutionProvider,
  PrismaClient,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import { PayrollFxOperationIntent } from './payroll-fx-operation.types';
import { PayrollFxOperationIntentConflictError } from './payroll-fx-operation.errors';
import { PrismaService } from '../database/prisma.service';

const databaseUrl = process.env.PAYROLL_FX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

function createIntent(
  overrides: Partial<PayrollFxOperationIntent> = {},
): PayrollFxOperationIntent {
  return {
    idempotencyKey: 'integration-payroll-fx-1',
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

describeDatabase('PayrollFxOperationRepository PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let repository: PayrollFxOperationRepository;

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl! }),
    });
    repository = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );
  });

  beforeEach(async () => {
    await prisma.payrollFxOperation.deleteMany();
    await prisma.task.deleteMany({
      where: { id: 'f8d10929-7c47-4d98-a811-6ba682b057d0' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(['stablefx', 'swapkit'] as const)(
    'creates and reads a %s operation before a Payroll task exists',
    async (provider) => {
      const created = await repository.create(
        createIntent({
          executionProvider: provider,
          idempotencyKey: `integration-${provider}`,
        }),
      );

      expect(created.taskId).toBeNull();
      expect(created.executionProvider).toBe(provider);
      await expect(repository.findById(created.operationId)).resolves.toEqual(
        created,
      );
    },
  );

  it('round-trips integers larger than JavaScript safe integer range', async () => {
    const amount = '900719925474099312345678901234567890';
    const created = await repository.create(
      createIntent({
        idempotencyKey: 'integration-large-amount',
        amountInBaseUnits: amount,
      }),
    );

    expect(created.amountInBaseUnits).toBe(amount);
    expect(
      (await repository.findById(created.operationId))?.amountInBaseUnits,
    ).toBe(amount);
  });

  it('converges concurrent equivalent creates on one durable operation', async () => {
    const intent = createIntent({
      idempotencyKey: 'integration-concurrent-create',
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.createOrGetByIdempotencyKey(intent),
      ),
    );

    expect(
      new Set(results.map((operation) => operation.operationId)).size,
    ).toBe(1);
    await expect(
      prisma.payrollFxOperation.count({
        where: { idempotencyKey: intent.idempotencyKey },
      }),
    ).resolves.toBe(1);
  });

  it('fails closed when an idempotency replay changes provider or amount', async () => {
    const intent = createIntent({
      idempotencyKey: 'integration-conflicting-replay',
    });
    await repository.createOrGetByIdempotencyKey(intent);

    await expect(
      repository.createOrGetByIdempotencyKey({
        ...intent,
        executionProvider: 'swapkit',
      }),
    ).rejects.toBeInstanceOf(PayrollFxOperationIntentConflictError);
    await expect(
      repository.createOrGetByIdempotencyKey({
        ...intent,
        amountInBaseUnits: '40000000',
      }),
    ).rejects.toBeInstanceOf(PayrollFxOperationIntentConflictError);
  });

  it('attaches a future Payroll task once without changing immutable intent', async () => {
    const taskId = 'f8d10929-7c47-4d98-a811-6ba682b057d0';
    const operation = await repository.create(
      createIntent({ idempotencyKey: 'integration-task-attach' }),
    );
    await prisma.task.create({
      data: {
        id: taskId,
        type: 'payroll',
        status: 'created',
        payload: {},
      },
    });

    await expect(
      repository.attachTask(operation.operationId, taskId),
    ).resolves.toMatchObject({
      taskId,
      executionProvider: 'stablefx',
    });
  });

  it('persists exact settlement evidence and bounded diagnostics', async () => {
    const operation = await repository.create(
      createIntent({ idempotencyKey: 'integration-settlement' }),
    );
    await prisma.payrollFxOperation.update({
      where: { operationId: operation.operationId },
      data: { status: 'SETTLEMENT_PENDING' },
    });

    const settled = await repository.recordSettlement(
      operation.operationId,
      'settlement_pending',
      {
        actualOutputBaseUnits: '90071992547409931234567890',
        settlementTransactionId: 'circle-settlement-id',
        settlementTransactionHash: `0x${'a'.repeat(64)}`,
        settledAt: new Date(),
        diagnosticSnapshot: { providerStatus: 'settled' },
      },
    );

    expect(settled).toMatchObject({
      actualOutputBaseUnits: '90071992547409931234567890',
      settlementTransactionId: 'circle-settlement-id',
      settlementTransactionHash: `0x${'a'.repeat(64)}`,
      diagnosticSnapshot: { providerStatus: 'settled' },
    });
  });

  it('enforces immutable execution intent at the database layer', async () => {
    const operation = await repository.create(
      createIntent({ idempotencyKey: 'integration-immutable-provider' }),
    );

    await expect(
      prisma.payrollFxOperation.update({
        where: { operationId: operation.operationId },
        data: { executionProvider: PrismaExecutionProvider.SWAPKIT },
      }),
    ).rejects.toThrow();
  });

  it('contains no legacy backfilled Payroll FX rows', async () => {
    await expect(prisma.payrollFxOperation.count()).resolves.toBe(0);
  });
});
