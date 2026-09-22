import { describe, expect, it } from "vitest";

import type { RecipientDraft } from "@/lib/wizpay";

import {
  calculatePayrollRunTotals,
  groupFeeInclusiveAmount,
  mergeSuccessfulSubmissionHashes,
  resolvePayrollRunRecipientCount,
} from "./useBatchPayroll";

function recipient(
  id: string,
  amount: string,
  targetToken: "USDC" | "EURC" = "USDC",
): RecipientDraft {
  return {
    id,
    address: `0x${id.padStart(40, "0")}`,
    amount,
    targetToken,
  };
}

describe("same-token payroll fee-inclusive approval", () => {
  it("tops up 0.01 USDC (10000 units) to 10025 at 25 bps", () => {
    const required = groupFeeInclusiveAmount([{ amount: "0.01" }], 6, 25n);
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
    expect(groupFeeInclusiveAmount([{ amount: "1.00" }], 6, 0n)).toBe(
      1_000_000n,
    );
  });
});

describe("payroll run success aggregation", () => {
  it("shows one recipient for a one-recipient single-token run", () => {
    const totals = calculatePayrollRunTotals([[recipient("1", "0.01")]], 6);

    expect(
      resolvePayrollRunRecipientCount(
        totals.totalRecipients,
        totals.totalRecipients,
        1,
      ),
    ).toBe(1);
  });

  it("shows all three recipients for a single-token run", () => {
    const totals = calculatePayrollRunTotals(
      [
        [
          recipient("1", "0.01"),
          recipient("2", "0.01"),
          recipient("3", "0.01"),
        ],
      ],
      6,
    );

    expect(
      resolvePayrollRunRecipientCount(
        totals.totalRecipients,
        totals.totalRecipients,
        3,
      ),
    ).toBe(3);
  });

  it("counts mixed groups across the entire run and preserves per-token totals", () => {
    const totals = calculatePayrollRunTotals(
      [
        [
          recipient("1", "0.01", "USDC"),
          recipient("2", "0.01", "EURC"),
          recipient("3", "0.01", "USDC"),
        ],
      ],
      6,
    );

    expect(totals.totalRecipients).toBe(3);
    expect(
      resolvePayrollRunRecipientCount(
        totals.totalRecipients,
        totals.totalRecipients,
        1,
      ),
    ).toBe(3);
    expect(totals.totalDistributed).toEqual({
      USDC: 20_000n,
      EURC: 10_000n,
    });
  });

  it("aggregates successful hashes across groups and ignores unconfirmed hashes", () => {
    const sameTokenHash = `0x${"a".repeat(64)}`;
    const crossTokenHash = `0x${"b".repeat(64)}`;

    const afterSameToken = mergeSuccessfulSubmissionHashes(
      [],
      [
        { status: "SUCCESS", txHash: sameTokenHash },
        { status: "PENDING", txHash: `0x${"c".repeat(64)}` },
      ],
    );
    const completeRun = mergeSuccessfulSubmissionHashes(afterSameToken, [
      { status: "SUCCESS", txHash: crossTokenHash },
      { status: "FAILED", txHash: `0x${"d".repeat(64)}` },
    ]);

    expect(completeRun).toEqual([sameTokenHash, crossTokenHash]);
  });

  it("deduplicates successful hashes across task refreshes", () => {
    const hash = `0x${"a".repeat(64)}`;

    expect(
      mergeSuccessfulSubmissionHashes(
        [hash],
        [{ status: "SUCCESS", txHash: hash.toUpperCase() }],
      ),
    ).toEqual([hash]);
  });
});
