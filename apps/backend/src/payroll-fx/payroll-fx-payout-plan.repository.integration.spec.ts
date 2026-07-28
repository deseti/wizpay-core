import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import type { PrismaService } from '../database/prisma.service';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import { PayrollFxPayoutPlanRepository } from './payroll-fx-payout-plan.repository';
import type { CreatePayrollFxPayoutPlanInput } from './payroll-fx-payout-plan.types';

const databaseUrl = process.env.PAYROLL_FX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const taskId = '2bb240b0-8335-4f26-9e70-49c9d2115cf3';

describeDatabase('PayrollFxPayoutPlanRepository PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let operations: PayrollFxOperationRepository;
  let plans: PayrollFxPayoutPlanRepository;
  let operationId: string;

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl! }),
    });
    operations = new PayrollFxOperationRepository(
      prisma as unknown as PrismaService,
    );
    plans = new PayrollFxPayoutPlanRepository(
      prisma as unknown as PrismaService,
    );
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "PayrollFxPayoutAllocation", "PayrollFxPayoutPlan", "PayrollFxOperation", "Task" CASCADE',
    );
    await prisma.task.create({
      data: {
        id: taskId,
        type: 'payroll',
        status: 'assigned',
        payload: {},
      },
    });
    const operation = await operations.create({
      idempotencyKey: `phase-4-${randomUUID()}`,
      walletMode: 'app',
      executionProvider: 'stablefx',
      sourceTokenAddress: '0x1111111111111111111111111111111111111111',
      destinationTokenAddress: '0x2222222222222222222222222222222222222222',
      sourceTokenSymbol: 'USDC',
      destinationTokenSymbol: 'EURC',
      network: 'ARC-TESTNET',
      sourceWalletAddress: '0x3333333333333333333333333333333333333333',
      treasuryWalletAddress: '0x4444444444444444444444444444444444444444',
      amountInBaseUnits: '900719925474099312345678',
      requestedMinimumOutputBaseUnits: null,
    });
    operationId = operation.operationId;
    await operations.attachTask(operationId, taskId);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function input(
    overrides: Partial<CreatePayrollFxPayoutPlanInput> = {},
  ): CreatePayrollFxPayoutPlanInput {
    return {
      operationId,
      taskId,
      executionProvider: 'stablefx',
      network: 'ARC-TESTNET',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      tokenDecimals: 6,
      sourceWalletAddress: '0x3333333333333333333333333333333333333333',
      settledBudgetBaseUnits: '900719925474099312345678',
      totalRequestedWeightBaseUnits: '3',
      totalAllocatedBaseUnits: '900719925474099312345678',
      dustBaseUnits: '0',
      allocationAlgorithmVersion: 'largest-remainder-v1',
      immutableInputHash: 'a'.repeat(64),
      allocations: [
        {
          recipientLineId: 'recipient-0',
          recipientIndex: 0,
          recipientAddress: '0x5555555555555555555555555555555555555555',
          destinationTokenAddress: '0x2222222222222222222222222222222222222222',
          requestedWeightBaseUnits: '1',
          allocatedAmountBaseUnits: '300239975158033104115226',
          deterministicRank: 0,
        },
        {
          recipientLineId: 'recipient-1',
          recipientIndex: 1,
          recipientAddress: '0x5555555555555555555555555555555555555555',
          destinationTokenAddress: '0x2222222222222222222222222222222222222222',
          requestedWeightBaseUnits: '2',
          allocatedAmountBaseUnits: '600479950316066208230452',
          deterministicRank: 1,
        },
      ],
      ...overrides,
    };
  }

  it('creates the plan and all recipient rows atomically with exact precision', async () => {
    const created = await plans.createOrGetImmutable(input());
    expect(created).toMatchObject({
      operationId,
      taskId,
      settledBudgetBaseUnits: '900719925474099312345678',
      totalAllocatedBaseUnits: '900719925474099312345678',
      dustBaseUnits: '0',
      status: 'planned',
    });
    expect(created.allocations).toHaveLength(2);
    expect(created.allocations[1].allocatedAmountBaseUnits).toBe(
      '600479950316066208230452',
    );
  });

  it('returns the same plan for an equivalent duplicate', async () => {
    const first = await plans.createOrGetImmutable(input());
    const second = await plans.createOrGetImmutable(input());
    expect(second.id).toBe(first.id);
    await expect(prisma.payrollFxPayoutPlan.count()).resolves.toBe(1);
  });

  it('converges concurrent equivalent creation on one immutable plan', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => plans.createOrGetImmutable(input())),
    );
    expect(new Set(results.map((plan) => plan.id)).size).toBe(1);
    await expect(prisma.payrollFxPayoutPlan.count()).resolves.toBe(1);
    await expect(prisma.payrollFxPayoutAllocation.count()).resolves.toBe(2);
  });

  it('fails closed for a conflicting immutable input hash', async () => {
    await plans.createOrGetImmutable(input());
    await expect(
      plans.createOrGetImmutable(input({ immutableInputHash: 'b'.repeat(64) })),
    ).rejects.toThrow('different immutable payout plan');
  });

  it('rolls back the plan when allocation insertion fails', async () => {
    const invalid = input({
      allocations: [
        input().allocations[0],
        {
          ...input().allocations[1],
          recipientLineId: 'recipient-0',
        },
      ],
    });
    await expect(plans.createOrGetImmutable(invalid)).rejects.toThrow();
    await expect(prisma.payrollFxPayoutPlan.count()).resolves.toBe(0);
    await expect(prisma.payrollFxPayoutAllocation.count()).resolves.toBe(0);
  });

  it('prevents persisted plan and allocation mutation', async () => {
    const created = await plans.createOrGetImmutable(input());
    await expect(
      prisma.payrollFxPayoutPlan.update({
        where: { id: created.id },
        data: { dustBaseUnits: '1' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.payrollFxPayoutAllocation.update({
        where: { id: created.allocations[0].id },
        data: { allocatedAmountBaseUnits: '0' },
      }),
    ).rejects.toThrow();
  });

  it('enforces one-way one-to-one task attachment in PostgreSQL', async () => {
    await expect(
      prisma.payrollFxOperation.update({
        where: { operationId },
        data: { taskId: null },
      }),
    ).rejects.toThrow();

    const other = await operations.create({
      idempotencyKey: 'phase-4-other-operation',
      walletMode: 'app',
      executionProvider: 'stablefx',
      sourceTokenAddress: '0x1111111111111111111111111111111111111111',
      destinationTokenAddress: '0x2222222222222222222222222222222222222222',
      sourceTokenSymbol: 'USDC',
      destinationTokenSymbol: 'EURC',
      network: 'ARC-TESTNET',
      sourceWalletAddress: '0x3333333333333333333333333333333333333333',
      treasuryWalletAddress: '0x4444444444444444444444444444444444444444',
      amountInBaseUnits: '1',
      requestedMinimumOutputBaseUnits: null,
    });
    await expect(
      operations.attachTask(other.operationId, taskId),
    ).rejects.toThrow();
  });
});
