import type { Task, TaskUnit } from '@prisma/client';
import type { PayrollFxOperation } from './payroll-fx-operation.types';
import { PayrollFxPayoutPlanService } from './payroll-fx-payout-plan.service';
import type { PayrollFxPayoutPlanRepository } from './payroll-fx-payout-plan.repository';
import type {
  CreatePayrollFxPayoutPlanInput,
  PayrollFxPayoutPlan,
} from './payroll-fx-payout-plan.types';
import type {
  PayrollFxTaskBindingService,
  PayrollFxTaskWithUnits,
} from './payroll-fx-task-binding.service';

const operationId = '8d00c7ac-d036-4448-94ea-2f38a51e64d8';
const taskId = '2bb240b0-8335-4f26-9e70-49c9d2115cf3';

function operation(
  overrides: Partial<PayrollFxOperation> = {},
): PayrollFxOperation {
  const now = new Date('2026-07-28T00:00:00.000Z');
  return {
    operationId,
    idempotencyKey: 'payroll-fx:app:stablefx:key',
    taskId,
    walletMode: 'app',
    executionProvider: 'stablefx',
    sourceTokenAddress: '0x1111111111111111111111111111111111111111',
    destinationTokenAddress: '0x2222222222222222222222222222222222222222',
    sourceTokenSymbol: 'USDC',
    destinationTokenSymbol: 'EURC',
    network: 'ARC-TESTNET',
    sourceWalletAddress: '0x3333333333333333333333333333333333333333',
    treasuryWalletAddress: '0x4444444444444444444444444444444444444444',
    amountInBaseUnits: '10200000',
    requestedMinimumOutputBaseUnits: null,
    status: 'completed',
    failureCode: null,
    failureMessage: null,
    quoteId: 'quote-id',
    quoteExpiresAt: now,
    expectedOutputBaseUnits: '10000000',
    actualOutputBaseUnits: '9999999',
    providerOperationId: 'trade-id',
    approvalTransactionId: null,
    approvalTransactionHash: null,
    fundingTransactionId: 'funding-id',
    fundingTransactionHash: '0x' + 'a'.repeat(64),
    settlementTransactionId: 'settlement-id',
    settlementTransactionHash: '0x' + 'b'.repeat(64),
    payoutTransactionId: 'payout-id',
    payoutTransactionHash: '0x' + 'c'.repeat(64),
    approvalTargetAddress: null,
    lastProviderStatus: 'completed',
    diagnosticSnapshot: null,
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    executionAttemptCount: 1,
    lastAttemptStartedAt: now,
    lastAttemptFinishedAt: now,
    recoveryFromStatus: null,
    submittedAt: now,
    fundingConfirmedAt: now,
    settledAt: now,
    payoutConfirmedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function task(): PayrollFxTaskWithUnits {
  const now = new Date('2026-07-28T00:00:00.000Z');
  const baseTask: Task = {
    id: taskId,
    type: 'payroll',
    status: 'assigned',
    totalUnits: 1,
    completedUnits: 0,
    failedUnits: 0,
    metadata: {
      referenceId: 'run-1',
      sourceToken: 'USDC',
      walletAddress: '0x3333333333333333333333333333333333333333',
    },
    payload: {},
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  const unit: TaskUnit = {
    id: 'a8af2670-af12-44b8-8388-f9030f23b118',
    taskId,
    type: 'batch',
    index: 0,
    status: 'PENDING',
    txHash: null,
    error: null,
    payload: {
      recipients: [
        {
          recipientIndex: 0,
          address: '0x5555555555555555555555555555555555555555',
          amountBaseUnits: '1000000',
          targetToken: 'EURC',
        },
        {
          recipientIndex: 1,
          address: '0x5555555555555555555555555555555555555555',
          amountBaseUnits: '2000000',
          targetToken: 'EURC',
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  };
  return { ...baseTask, units: [unit] };
}

describe('PayrollFxPayoutPlanService', () => {
  const createOrGetImmutable = jest.fn(
    (input: CreatePayrollFxPayoutPlanInput): Promise<PayrollFxPayoutPlan> =>
      Promise.resolve({
        ...input,
        id: '1e197401-33d8-4b6c-98dd-7ee90c8c6caf',
        status: 'planned',
        createdAt: new Date('2026-07-28T00:00:00.000Z'),
        allocations: input.allocations.map((allocation, index) => ({
          ...allocation,
          id: `allocation-${index}`,
          planId: '1e197401-33d8-4b6c-98dd-7ee90c8c6caf',
          status: 'planned',
          createdAt: new Date('2026-07-28T00:00:00.000Z'),
        })),
      }),
  );
  const binding = {
    bindEligibleTask: jest.fn(),
  } as unknown as PayrollFxTaskBindingService;
  const repository = {
    createOrGetImmutable,
  } as unknown as PayrollFxPayoutPlanRepository;
  const service = new PayrollFxPayoutPlanService(binding, repository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a planning-only snapshot from exact settled output', async () => {
    await service.create(operation(), task());
    expect(createOrGetImmutable).toHaveBeenCalledWith(
      expect.objectContaining({
        settledBudgetBaseUnits: '9999999',
        totalRequestedWeightBaseUnits: '3000000',
        totalAllocatedBaseUnits: '9999999',
        dustBaseUnits: '0',
        executionProvider: 'stablefx',
        sourceWalletAddress: '0x3333333333333333333333333333333333333333',
        allocationAlgorithmVersion: 'largest-remainder-v1',
      }),
    );
    const input = createOrGetImmutable.mock.calls[0][0];
    expect(input.immutableInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(input.allocations).toHaveLength(2);
    expect(input.allocations[0].recipientAddress).toBe(
      input.allocations[1].recipientAddress,
    );
    expect(input.allocations[0]).not.toHaveProperty('transactionHash');
    expect(input.allocations[0]).not.toHaveProperty('transactionId');
  });

  it('rejects creation before accepted settled evidence', async () => {
    await expect(
      service.create(
        operation({
          status: 'funding_pending',
          actualOutputBaseUnits: null,
          settlementTransactionHash: null,
          settledAt: null,
        }),
        task(),
      ),
    ).rejects.toThrow('settled-output evidence');
    expect(createOrGetImmutable).not.toHaveBeenCalled();
  });

  it('rejects creation before durable task attachment', async () => {
    await expect(
      service.create(operation({ taskId: null }), task()),
    ).rejects.toThrow('durably attached');
  });

  it('can plan an already FX-completed operation without provider calls', async () => {
    await expect(service.create(operation(), task())).resolves.toBeDefined();
    expect(createOrGetImmutable).toHaveBeenCalledTimes(1);
  });

  it('uses identical canonical input hashes across repeated creation', async () => {
    await service.create(operation(), task());
    await service.create(operation(), task());
    expect(createOrGetImmutable.mock.calls[0][0].immutableInputHash).toBe(
      createOrGetImmutable.mock.calls[1][0].immutableInputHash,
    );
  });

  it('does not infer legacy task rows without exact base-unit snapshots', async () => {
    const legacy = task();
    legacy.units[0].payload = {
      recipients: [
        {
          address: '0x5555555555555555555555555555555555555555',
          amount: '1',
          targetToken: 'EURC',
        },
      ],
    };
    await expect(service.create(operation(), legacy)).rejects.toThrow(
      'durable original recipient index',
    );
  });
});
