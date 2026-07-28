import { allocatePayrollFxBudget } from './payroll-fx-allocation';
import type { PayrollFxAllocationInput } from './payroll-fx-allocation.types';

function recipient(
  index: number,
  weight: string,
  addressSuffix = index + 1,
): PayrollFxAllocationInput {
  return {
    recipientLineId: `recipient-${index}`,
    recipientIndex: index,
    recipientAddress: `0x${addressSuffix.toString(16).padStart(40, '0')}`,
    destinationTokenAddress: '0x2222222222222222222222222222222222222222',
    requestedWeightBaseUnits: weight,
  };
}

describe('allocatePayrollFxBudget', () => {
  it('allocates the full budget to one recipient', () => {
    expect(
      allocatePayrollFxBudget('900719925474099312345678', [recipient(0, '1')]),
    ).toMatchObject({
      totalAllocatedBaseUnits: '900719925474099312345678',
      dustBaseUnits: '0',
      allocations: [{ allocatedAmountBaseUnits: '900719925474099312345678' }],
    });
  });

  it('splits an equal even budget exactly', () => {
    const plan = allocatePayrollFxBudget('10', [
      recipient(0, '1'),
      recipient(1, '1'),
    ]);
    expect(
      plan.allocations.map((entry) => entry.allocatedAmountBaseUnits),
    ).toEqual(['5', '5']);
  });

  it('allocates unequal weights proportionally', () => {
    const plan = allocatePayrollFxBudget('100', [
      recipient(0, '1'),
      recipient(1, '3'),
    ]);
    expect(
      plan.allocations.map((entry) => entry.allocatedAmountBaseUnits),
    ).toEqual(['25', '75']);
  });

  it('awards residual units by largest remainder', () => {
    const plan = allocatePayrollFxBudget('5', [
      recipient(0, '1'),
      recipient(1, '2'),
    ]);
    expect(
      plan.allocations.map((entry) => entry.allocatedAmountBaseUnits),
    ).toEqual(['2', '3']);
  });

  it('uses original index for equal-remainder ties', () => {
    const plan = allocatePayrollFxBudget('1', [
      recipient(9, '1'),
      recipient(2, '1'),
    ]);
    expect(
      plan.allocations.map((entry) => [
        entry.recipientIndex,
        entry.allocatedAmountBaseUnits,
      ]),
    ).toEqual([
      [2, '1'],
      [9, '0'],
    ]);
  });

  it('is independent of input array iteration order', () => {
    const first = allocatePayrollFxBudget('7', [
      recipient(4, '2'),
      recipient(1, '3'),
      recipient(2, '5'),
    ]);
    const second = allocatePayrollFxBudget('7', [
      recipient(2, '5'),
      recipient(4, '2'),
      recipient(1, '3'),
    ]);
    expect(second).toEqual(first);
  });

  it('conserves every representable base unit with zero dust', () => {
    const plan = allocatePayrollFxBudget('1000001', [
      recipient(0, '123456'),
      recipient(1, '234567'),
      recipient(2, '345678'),
    ]);
    const sum = plan.allocations.reduce(
      (total, entry) => total + BigInt(entry.allocatedAmountBaseUnits),
      0n,
    );
    expect(sum).toBe(1000001n);
    expect(plan.dustBaseUnits).toBe('0');
  });

  it('defines zero budget as zero allocation for positive weights', () => {
    const plan = allocatePayrollFxBudget('0', [
      recipient(0, '1'),
      recipient(1, '2'),
    ]);
    expect(
      plan.allocations.map((entry) => entry.allocatedAmountBaseUnits),
    ).toEqual(['0', '0']);
  });

  it.each(['0', '-1', '1.5', '1e6', ' 1'])(
    'rejects invalid recipient weight %s',
    (weight) => {
      expect(() =>
        allocatePayrollFxBudget('10', [recipient(0, weight)]),
      ).toThrow();
    },
  );

  it('rejects an empty recipient list', () => {
    expect(() => allocatePayrollFxBudget('10', [])).toThrow(
      'at least one recipient',
    );
  });

  it('preserves duplicate addresses as separate rows', () => {
    const plan = allocatePayrollFxBudget('3', [
      recipient(0, '1', 7),
      recipient(1, '2', 7),
    ]);
    expect(plan.allocations).toHaveLength(2);
    expect(
      plan.allocations.map((entry) => entry.allocatedAmountBaseUnits),
    ).toEqual(['1', '2']);
  });

  it('keeps six-decimal base-unit values exact', () => {
    const plan = allocatePayrollFxBudget('1234567', [
      recipient(0, '1000000'),
      recipient(1, '2000000'),
    ]);
    expect(plan.totalAllocatedBaseUnits).toBe('1234567');
  });

  it('handles values above Number.MAX_SAFE_INTEGER exactly', () => {
    const budget = '999999999999999999999999999999999999';
    const plan = allocatePayrollFxBudget(budget, [
      recipient(0, '900719925474099312345678'),
      recipient(1, '1801439850948198624691356'),
    ]);
    expect(plan.totalAllocatedBaseUnits).toBe(budget);
  });

  it('handles the maximum current payroll size without per-base-unit work', () => {
    const entries = Array.from({ length: 50 }, (_, index) =>
      recipient(index, String(index + 1)),
    );
    const plan = allocatePayrollFxBudget(
      '999999999999999999999999',
      entries.reverse(),
    );
    expect(plan.allocations).toHaveLength(50);
    expect(plan.totalAllocatedBaseUnits).toBe('999999999999999999999999');
  });

  it('rejects duplicate line identities and indexes', () => {
    expect(() =>
      allocatePayrollFxBudget('10', [recipient(0, '1'), recipient(0, '2')]),
    ).toThrow('unique');
  });
});
