import type { Task, TaskUnit } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { buildPayrollFxOperationIdempotencyKey } from './payroll-fx-idempotency';
import type { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import type { PayrollFxOperation } from './payroll-fx-operation.types';
import { PayrollFxTaskBindingService } from './payroll-fx-task-binding.service';

const taskId = '2bb240b0-8335-4f26-9e70-49c9d2115cf3';

function task(
  overrides: Partial<Task> = {},
  targetToken = 'EURC',
): Task & { units: TaskUnit[] } {
  const now = new Date('2026-07-28T00:00:00.000Z');
  return {
    id: taskId,
    type: 'payroll',
    status: 'assigned',
    totalUnits: 1,
    completedUnits: 0,
    failedUnits: 0,
    metadata: {
      referenceId: 'run-1',
      sourceToken: 'USDC',
      walletAddress: '0x1111111111111111111111111111111111111111',
    },
    payload: {},
    result: null,
    createdAt: now,
    updatedAt: now,
    units: [
      {
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
              address: '0x2222222222222222222222222222222222222222',
              amountBaseUnits: '1000000',
              targetToken,
            },
          ],
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    ...overrides,
  };
}

function operation(
  overrides: Partial<PayrollFxOperation> = {},
): PayrollFxOperation {
  const now = new Date('2026-07-28T00:00:00.000Z');
  return {
    operationId: '8d00c7ac-d036-4448-94ea-2f38a51e64d8',
    idempotencyKey: buildPayrollFxOperationIdempotencyKey(
      'PAYROLL-FX-run-1-EURC',
    ),
    taskId: null,
    walletMode: 'app',
    executionProvider: 'stablefx',
    sourceTokenAddress: '0x3333333333333333333333333333333333333333',
    destinationTokenAddress: '0x4444444444444444444444444444444444444444',
    sourceTokenSymbol: 'USDC',
    destinationTokenSymbol: 'EURC',
    network: 'ARC-TESTNET',
    sourceWalletAddress: '0x1111111111111111111111111111111111111111',
    treasuryWalletAddress: '0x5555555555555555555555555555555555555555',
    amountInBaseUnits: '1020000',
    requestedMinimumOutputBaseUnits: null,
    status: 'completed',
    failureCode: null,
    failureMessage: null,
    quoteId: null,
    quoteExpiresAt: null,
    expectedOutputBaseUnits: '1000000',
    actualOutputBaseUnits: '999999',
    providerOperationId: 'trade-id',
    approvalTransactionId: null,
    approvalTransactionHash: null,
    fundingTransactionId: null,
    fundingTransactionHash: null,
    settlementTransactionId: null,
    settlementTransactionHash: '0x' + 'a'.repeat(64),
    payoutTransactionId: null,
    payoutTransactionHash: '0x' + 'b'.repeat(64),
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

describe('PayrollFxTaskBindingService', () => {
  const findUnique = jest.fn();
  const findByIdempotencyKey = jest.fn();
  const attachTask = jest.fn();
  const prisma = {
    task: { findUnique },
  } as unknown as PrismaService;
  const operations = {
    findByIdempotencyKey,
    attachTask,
  } as unknown as PayrollFxOperationRepository;
  const service = new PayrollFxTaskBindingService(prisma, operations);

  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue(task());
    findByIdempotencyKey.mockImplementation((key: string) =>
      Promise.resolve(
        key === buildPayrollFxOperationIdempotencyKey('PAYROLL-FX-run-1-EURC')
          ? operation()
          : null,
      ),
    );
    attachTask.mockResolvedValue(operation({ taskId }));
  });

  it('attaches the correlated StableFX operation to the intended task', async () => {
    await expect(service.bindEligibleTask(taskId)).resolves.toMatchObject({
      operation: { taskId },
      task: { id: taskId },
    });
    expect(attachTask).toHaveBeenCalledWith(operation().operationId, taskId);
  });

  it('uses the existing one-way repository attachment idempotently', async () => {
    attachTask.mockResolvedValue(operation({ taskId }));
    await service.bindEligibleTask(taskId);
    await service.bindEligibleTask(taskId);
    expect(attachTask).toHaveBeenCalledTimes(2);
  });

  it('rejects replacement with a task already attached elsewhere', async () => {
    findByIdempotencyKey.mockResolvedValue(
      operation({ taskId: '5edb0d31-c7db-4d5b-9fc7-f14c8d81082e' }),
    );
    await expect(service.bindEligibleTask(taskId)).rejects.toThrow(
      'already attached to another task',
    );
    expect(attachTask).not.toHaveBeenCalled();
  });

  it('rejects conflicting immutable wallet intent', async () => {
    findByIdempotencyKey.mockResolvedValue(
      operation({
        sourceWalletAddress: '0x9999999999999999999999999999999999999999',
      }),
    );
    await expect(service.bindEligibleTask(taskId)).rejects.toThrow(
      'App Wallet ownership differs',
    );
  });

  it('rejects a persisted SwapKit provider regardless of environment', async () => {
    findByIdempotencyKey.mockResolvedValue(
      operation({ executionProvider: 'swapkit' }),
    );
    await expect(service.bindEligibleTask(taskId)).rejects.toThrow(
      'persisted provider is not StableFX',
    );
  });

  it('does not bind or create a plan for direct-token Payroll', async () => {
    findUnique.mockResolvedValue(task({}, 'USDC'));
    await expect(service.bindEligibleTask(taskId)).resolves.toBeNull();
    expect(findByIdempotencyKey).not.toHaveBeenCalled();
    expect(attachTask).not.toHaveBeenCalled();
  });
});
