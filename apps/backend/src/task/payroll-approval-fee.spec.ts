import { payrollSameTokenApprovalAmountWithFee } from './task.service';

describe('payrollSameTokenApprovalAmountWithFee', () => {
  it('includes the 25 bps payroll fee for 0.01 USDC', () => {
    const amount = payrollSameTokenApprovalAmountWithFee(
      [{ targetToken: 'USDC', amountUnits: 10_000n }],
      'USDC',
      25n,
    );
    expect(amount).toBe(10_025n);
  });

  it('sums per-recipient fees like the on-chain contract', () => {
    const amount = payrollSameTokenApprovalAmountWithFee(
      [
        { targetToken: 'USDC', amountUnits: 10_000n },
        { targetToken: 'USDC', amountUnits: 20_000n },
      ],
      'USDC',
      25n,
    );
    expect(amount).toBe(30_075n);
  });

  it('excludes cross-token recipients', () => {
    const amount = payrollSameTokenApprovalAmountWithFee(
      [
        { targetToken: 'USDC', amountUnits: 10_000n },
        { targetToken: 'EURC', amountUnits: 10_000n },
      ],
      'USDC',
      25n,
    );
    expect(amount).toBe(10_025n);
  });

  it('matches the verified 0.10 USDC settlement (100000 + 250 fee)', () => {
    const amount = payrollSameTokenApprovalAmountWithFee(
      [{ targetToken: 'USDC', amountUnits: 100_000n }],
      'USDC',
      25n,
    );
    expect(amount).toBe(100_250n);
  });

  it('is fee-exclusive when feeBps is zero', () => {
    const amount = payrollSameTokenApprovalAmountWithFee(
      [{ targetToken: 'USDC', amountUnits: 1_000_000n }],
      'USDC',
      0n,
    );
    expect(amount).toBe(1_000_000n);
  });
});
