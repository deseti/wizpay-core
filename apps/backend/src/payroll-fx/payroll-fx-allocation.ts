import { PayrollFxPayoutPlanValidationError } from './payroll-fx-payout-plan.errors';
import type {
  PayrollFxAllocationInput,
  PayrollFxAllocationPlan,
} from './payroll-fx-allocation.types';

interface WorkingAllocation {
  input: PayrollFxAllocationInput;
  floor: bigint;
  remainder: bigint;
  deterministicRank: number;
}

const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;

export function allocatePayrollFxBudget(
  settledBudgetBaseUnits: string,
  entries: readonly PayrollFxAllocationInput[],
): PayrollFxAllocationPlan {
  const budget = requireUnsignedInteger(
    settledBudgetBaseUnits,
    'settled allocation budget',
    true,
  );
  if (entries.length === 0) {
    throw new PayrollFxPayoutPlanValidationError(
      'Payroll FX payout plan requires at least one recipient.',
    );
  }

  const canonicalEntries = [...entries].sort(compareCanonicalEntry);
  assertUniqueRecipientIdentity(canonicalEntries);
  const weights = canonicalEntries.map((entry) =>
    requireUnsignedInteger(
      entry.requestedWeightBaseUnits,
      `recipient ${entry.recipientLineId} weight`,
      false,
    ),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  const working: WorkingAllocation[] = canonicalEntries.map((input, index) => {
    const numerator = budget * weights[index];
    return {
      input,
      floor: numerator / totalWeight,
      remainder: numerator % totalWeight,
      deterministicRank: -1,
    };
  });
  const distributed = working.reduce((sum, item) => sum + item.floor, 0n);
  const residual = budget - distributed;
  const ranked = [...working].sort(compareRemainderRank);

  if (residual > BigInt(ranked.length)) {
    throw new PayrollFxPayoutPlanValidationError(
      'Payroll FX allocation residual exceeded recipient count.',
    );
  }

  ranked.forEach((item, rank) => {
    item.deterministicRank = rank;
    if (BigInt(rank) < residual) item.floor += 1n;
  });

  const totalAllocated = working.reduce((sum, item) => sum + item.floor, 0n);
  return {
    settledBudgetBaseUnits: budget.toString(),
    totalRequestedWeightBaseUnits: totalWeight.toString(),
    totalAllocatedBaseUnits: totalAllocated.toString(),
    dustBaseUnits: (budget - totalAllocated).toString(),
    allocations: working.map((item) => ({
      ...item.input,
      requestedWeightBaseUnits: BigInt(
        item.input.requestedWeightBaseUnits,
      ).toString(),
      allocatedAmountBaseUnits: item.floor.toString(),
      deterministicRank: item.deterministicRank,
    })),
  };
}

function requireUnsignedInteger(
  value: string,
  label: string,
  allowZero: boolean,
): bigint {
  if (!UNSIGNED_INTEGER.test(value)) {
    throw new PayrollFxPayoutPlanValidationError(
      `${label} must be an unsigned integer base-unit string.`,
    );
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) {
    throw new PayrollFxPayoutPlanValidationError(
      `${label} must be greater than zero.`,
    );
  }
  return parsed;
}

function assertUniqueRecipientIdentity(
  entries: readonly PayrollFxAllocationInput[],
): void {
  const lineIds = new Set<string>();
  const indexes = new Set<number>();
  for (const entry of entries) {
    if (!entry.recipientLineId.trim()) {
      throw new PayrollFxPayoutPlanValidationError(
        'Recipient line ID must not be empty.',
      );
    }
    if (
      !Number.isSafeInteger(entry.recipientIndex) ||
      entry.recipientIndex < 0
    ) {
      throw new PayrollFxPayoutPlanValidationError(
        'Recipient index must be a non-negative safe integer.',
      );
    }
    if (
      lineIds.has(entry.recipientLineId) ||
      indexes.has(entry.recipientIndex)
    ) {
      throw new PayrollFxPayoutPlanValidationError(
        'Recipient line IDs and indexes must be unique.',
      );
    }
    lineIds.add(entry.recipientLineId);
    indexes.add(entry.recipientIndex);
  }
}

function compareCanonicalEntry(
  left: PayrollFxAllocationInput,
  right: PayrollFxAllocationInput,
): number {
  return (
    left.recipientIndex - right.recipientIndex ||
    left.recipientLineId.localeCompare(right.recipientLineId)
  );
}

function compareRemainderRank(
  left: WorkingAllocation,
  right: WorkingAllocation,
): number {
  if (left.remainder !== right.remainder) {
    return left.remainder > right.remainder ? -1 : 1;
  }
  return compareCanonicalEntry(left.input, right.input);
}
