import { Prisma } from '@prisma/client';
import type {
  CreatePayrollFxPayoutPlanInput,
  PayrollFxPayoutPlan,
} from './payroll-fx-payout-plan.types';

export type PayrollFxPayoutPlanRecord = Prisma.PayrollFxPayoutPlanGetPayload<{
  include: { allocations: true };
}>;

export function toPrismaPayrollFxPayoutPlan(
  input: CreatePayrollFxPayoutPlanInput,
): Prisma.PayrollFxPayoutPlanCreateInput {
  return {
    operation: { connect: { operationId: input.operationId } },
    task: { connect: { id: input.taskId } },
    executionProvider: 'STABLEFX',
    network: input.network,
    tokenAddress: input.tokenAddress,
    tokenDecimals: input.tokenDecimals,
    sourceWalletAddress: input.sourceWalletAddress,
    settledBudgetBaseUnits: input.settledBudgetBaseUnits,
    totalRequestedWeightBaseUnits: input.totalRequestedWeightBaseUnits,
    totalAllocatedBaseUnits: input.totalAllocatedBaseUnits,
    dustBaseUnits: input.dustBaseUnits,
    allocationAlgorithmVersion: input.allocationAlgorithmVersion,
    immutableInputHash: input.immutableInputHash,
    status: 'PLANNED',
    allocations: {
      create: input.allocations.map((allocation) => ({
        recipientLineId: allocation.recipientLineId,
        recipientIndex: allocation.recipientIndex,
        recipientAddress: allocation.recipientAddress,
        destinationTokenAddress: allocation.destinationTokenAddress,
        requestedWeightBaseUnits: allocation.requestedWeightBaseUnits,
        allocatedAmountBaseUnits: allocation.allocatedAmountBaseUnits,
        deterministicRank: allocation.deterministicRank,
        status: 'PLANNED',
      })),
    },
  };
}

export function mapPayrollFxPayoutPlan(
  record: PayrollFxPayoutPlanRecord,
): PayrollFxPayoutPlan {
  return {
    id: record.id,
    operationId: record.operationId,
    taskId: record.taskId,
    executionProvider: 'stablefx',
    network: record.network,
    tokenAddress: record.tokenAddress,
    tokenDecimals: record.tokenDecimals,
    sourceWalletAddress: record.sourceWalletAddress,
    settledBudgetBaseUnits: record.settledBudgetBaseUnits,
    totalRequestedWeightBaseUnits: record.totalRequestedWeightBaseUnits,
    totalAllocatedBaseUnits: record.totalAllocatedBaseUnits,
    dustBaseUnits: record.dustBaseUnits,
    allocationAlgorithmVersion: record.allocationAlgorithmVersion,
    immutableInputHash: record.immutableInputHash,
    status: 'planned',
    createdAt: record.createdAt,
    allocations: [...record.allocations]
      .sort((left, right) => left.recipientIndex - right.recipientIndex)
      .map((allocation) => ({
        id: allocation.id,
        planId: allocation.planId,
        recipientLineId: allocation.recipientLineId,
        recipientIndex: allocation.recipientIndex,
        recipientAddress: allocation.recipientAddress,
        destinationTokenAddress: allocation.destinationTokenAddress,
        requestedWeightBaseUnits: allocation.requestedWeightBaseUnits,
        allocatedAmountBaseUnits: allocation.allocatedAmountBaseUnits,
        deterministicRank: allocation.deterministicRank,
        status: 'planned',
        createdAt: allocation.createdAt,
      })),
  };
}
