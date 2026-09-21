import { describe, expect, it } from "vitest";

import { groupFeeInclusiveAmount } from "./useBatchPayroll";

describe("same-token payroll fee-inclusive approval", () => {
  it("tops up 0.01 USDC (10000 units) to 10025 at 25 bps", () => {
    const required = groupFeeInclusiveAmount(
      [{ amount: "0.01" }],
      6,
      25n,
    );
    expect(required).toBe(10_000n + 25n);
    expect(required).toBe(10_025n);
  });

  it("computes per-recipient fees (matches WizPayPayrollMainnet)", () => {
    const required = groupFeeInclusiveAmount(
      [{ amount: "0.01" }, { amount: "0.02" }],
      6,
      25n,
    );
    // 10000 + 25 + 20000 + 50
    expect(required).toBe(30_075n);
  });

  it("returns zero fee when feeBps is zero", () => {
    expect(
      groupFeeInclusiveAmount([{ amount: "1.00" }], 6, 0n),
    ).toBe(1_000_000n);
  });
});
