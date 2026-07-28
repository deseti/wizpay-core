import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { allocatePayrollFxBudget } from './payroll-fx-allocation';
import type { PayrollFxAllocationInput } from './payroll-fx-allocation.types';
import type { PayrollFxOperation } from './payroll-fx-operation.types';
import { PayrollFxPayoutPlanValidationError } from './payroll-fx-payout-plan.errors';
import { PayrollFxPayoutPlanRepository } from './payroll-fx-payout-plan.repository';
import {
  PAYROLL_FX_ALLOCATION_ALGORITHM_VERSION,
  type PayrollFxPayoutPlan,
} from './payroll-fx-payout-plan.types';
import {
  PayrollFxTaskBindingService,
  type PayrollFxTaskWithUnits,
} from './payroll-fx-task-binding.service';

const TOKEN_DECIMALS: Record<string, number> = { USDC: 6, EURC: 6 };
const ACCEPTED_SETTLED_STATUSES = new Set([
  'settled',
  'payout_pending',
  'completed',
  'recovery_required',
]);

@Injectable()
export class PayrollFxPayoutPlanService {
  constructor(
    private readonly binding: PayrollFxTaskBindingService,
    private readonly plans: PayrollFxPayoutPlanRepository,
  ) {}

  async createForTaskIfEligible(
    taskId: string,
  ): Promise<PayrollFxPayoutPlan | null> {
    const bound = await this.binding.bindEligibleTask(taskId);
    if (!bound) return null;
    return this.create(bound.operation, bound.task);
  }

  async create(
    operation: PayrollFxOperation,
    task: PayrollFxTaskWithUnits,
  ): Promise<PayrollFxPayoutPlan> {
    this.assertSettledEvidence(operation, task.id);
    const tokenSymbol = operation.destinationTokenSymbol.toUpperCase();
    const tokenDecimals = TOKEN_DECIMALS[tokenSymbol];
    if (tokenDecimals === undefined) {
      throw new PayrollFxPayoutPlanValidationError(
        `Unsupported Payroll FX destination token ${tokenSymbol}.`,
      );
    }

    const snapshot = this.buildRecipientSnapshot(task, operation);
    const allocation = allocatePayrollFxBudget(
      operation.actualOutputBaseUnits!,
      snapshot,
    );
    const immutableInputHash = this.hashImmutableInput({
      operation,
      taskId: task.id,
      tokenDecimals,
      budget: allocation.settledBudgetBaseUnits,
      snapshot,
    });

    return this.plans.createOrGetImmutable({
      operationId: operation.operationId,
      taskId: task.id,
      executionProvider: 'stablefx',
      network: operation.network,
      tokenAddress: operation.destinationTokenAddress.toLowerCase(),
      tokenDecimals,
      sourceWalletAddress: operation.sourceWalletAddress.toLowerCase(),
      settledBudgetBaseUnits: allocation.settledBudgetBaseUnits,
      totalRequestedWeightBaseUnits: allocation.totalRequestedWeightBaseUnits,
      totalAllocatedBaseUnits: allocation.totalAllocatedBaseUnits,
      dustBaseUnits: allocation.dustBaseUnits,
      allocationAlgorithmVersion: PAYROLL_FX_ALLOCATION_ALGORITHM_VERSION,
      immutableInputHash,
      allocations: allocation.allocations,
    });
  }

  private assertSettledEvidence(
    operation: PayrollFxOperation,
    taskId: string,
  ): void {
    if (operation.executionProvider !== 'stablefx') {
      throw new PayrollFxPayoutPlanValidationError(
        'Payroll FX payout planning supports only persisted StableFX operations.',
      );
    }
    if (operation.taskId !== taskId) {
      throw new PayrollFxPayoutPlanValidationError(
        'Payroll FX operation must be durably attached before payout planning.',
      );
    }
    if (
      !ACCEPTED_SETTLED_STATUSES.has(operation.status) ||
      operation.actualOutputBaseUnits === null ||
      operation.settlementTransactionHash === null ||
      operation.settledAt === null
    ) {
      throw new PayrollFxPayoutPlanValidationError(
        'Payroll FX payout planning requires accepted settled-output evidence.',
      );
    }
  }

  private buildRecipientSnapshot(
    task: PayrollFxTaskWithUnits,
    operation: PayrollFxOperation,
  ): PayrollFxAllocationInput[] {
    const targetToken = operation.destinationTokenSymbol.toUpperCase();
    const tokenAddress = operation.destinationTokenAddress.toLowerCase();
    const snapshot: PayrollFxAllocationInput[] = [];

    for (const unit of [...task.units].sort(
      (left, right) => left.index - right.index,
    )) {
      const unitPayload = this.asObject(unit.payload);
      if (!Array.isArray(unitPayload.recipients)) continue;
      for (const rawRecipient of unitPayload.recipients) {
        const recipient = this.asObject(rawRecipient);
        const recipientToken = this.requiredString(
          recipient.targetToken,
          'recipient targetToken',
        ).toUpperCase();
        if (recipientToken !== targetToken) continue;
        const recipientIndex = recipient.recipientIndex;
        if (
          typeof recipientIndex !== 'number' ||
          !Number.isSafeInteger(recipientIndex) ||
          recipientIndex < 0
        ) {
          throw new PayrollFxPayoutPlanValidationError(
            'Payroll task lacks a durable original recipient index.',
          );
        }
        const address = this.requiredString(
          recipient.address,
          'recipient address',
        ).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) {
          throw new PayrollFxPayoutPlanValidationError(
            `Payroll recipient ${recipientIndex} has an invalid normalized address.`,
          );
        }
        snapshot.push({
          recipientLineId: `recipient-${recipientIndex}`,
          recipientIndex,
          recipientAddress: address,
          destinationTokenAddress: tokenAddress,
          requestedWeightBaseUnits: this.requiredString(
            recipient.amountBaseUnits,
            'recipient amountBaseUnits',
          ),
        });
      }
    }
    return snapshot;
  }

  private hashImmutableInput(input: {
    operation: PayrollFxOperation;
    taskId: string;
    tokenDecimals: number;
    budget: string;
    snapshot: PayrollFxAllocationInput[];
  }): string {
    const canonical = JSON.stringify({
      operationId: input.operation.operationId,
      taskId: input.taskId,
      executionProvider: input.operation.executionProvider,
      network: input.operation.network.toUpperCase(),
      destinationTokenAddress:
        input.operation.destinationTokenAddress.toLowerCase(),
      tokenDecimals: input.tokenDecimals,
      sourceWalletAddress: input.operation.sourceWalletAddress.toLowerCase(),
      settledBudgetBaseUnits: input.budget,
      allocationAlgorithmVersion: PAYROLL_FX_ALLOCATION_ALGORITHM_VERSION,
      recipients: [...input.snapshot]
        .sort(
          (left, right) =>
            left.recipientIndex - right.recipientIndex ||
            left.recipientLineId.localeCompare(right.recipientLineId),
        )
        .map((recipient) => ({
          recipientLineId: recipient.recipientLineId,
          recipientIndex: recipient.recipientIndex,
          recipientAddress: recipient.recipientAddress,
          destinationTokenAddress: recipient.destinationTokenAddress,
          requestedWeightBaseUnits: BigInt(
            recipient.requestedWeightBaseUnits,
          ).toString(),
        })),
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new PayrollFxPayoutPlanValidationError(
        `Payroll task is missing immutable ${label}.`,
      );
    }
    return value.trim();
  }
}
