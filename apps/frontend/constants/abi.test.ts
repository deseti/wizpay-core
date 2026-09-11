import { describe, expect, it } from "vitest";
import {
  WIZPAY_ABI,
  WIZPAY_DIRECT_USDC_PAYMENT_EVENT,
  WIZPAY_PAYROLL_REFERENCE_CONSUMED_EVENT,
} from "./abi";

describe("WizPay Mainnet V2 receipt ABI", () => {
  it("keeps the exact ordered payment and domain-bound summary events", () => {
    expect(WIZPAY_ABI).toContain(WIZPAY_DIRECT_USDC_PAYMENT_EVENT);
    expect(WIZPAY_ABI).toContain(WIZPAY_PAYROLL_REFERENCE_CONSUMED_EVENT);
    expect(
      WIZPAY_DIRECT_USDC_PAYMENT_EVENT.inputs.map((input) => input.name),
    ).toEqual([
      "referenceHash",
      "payer",
      "recipient",
      "paymentIndex",
      "grossAmount",
      "netAmount",
      "feeAmount",
    ]);
    expect(
      WIZPAY_PAYROLL_REFERENCE_CONSUMED_EVENT.inputs.map((input) => input.name),
    ).toEqual([
      "referenceHash",
      "payer",
      "token",
      "batchDigest",
      "totalAmount",
      "totalOut",
      "totalFees",
      "recipientCount",
      "referenceId",
    ]);
  });
});
