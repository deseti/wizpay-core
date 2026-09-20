import { describe, expect, it } from "vitest";
import {
  WIZPAY_ABI,
  WIZPAY_DIRECT_USDC_PAYMENT_EVENT,
  WIZPAY_MAINNET_ABI,
  WIZPAY_PAYROLL_REFERENCE_CONSUMED_EVENT,
  WIZPAY_TESTNET_LEGACY_ABI,
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

  it("keeps legacy FX reads Testnet-only and routes Mainnet ABI to PayrollMainnet", () => {
    const functionNames = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((entry) => entry.type === "function").map((entry) => entry.name);
    expect(functionNames(WIZPAY_MAINNET_ABI)).not.toContain("fxEngine");
    expect(functionNames(WIZPAY_MAINNET_ABI)).not.toContain("getEstimatedOutput");
    expect(functionNames(WIZPAY_MAINNET_ABI)).not.toContain("batchRouteAndPay");
    expect(functionNames(WIZPAY_MAINNET_ABI)).toContain("executeSameTokenPayroll");
    expect(functionNames(WIZPAY_MAINNET_ABI)).toContain("executeCrossTokenPayroll");
    expect(functionNames(WIZPAY_TESTNET_LEGACY_ABI)).toContain("fxEngine");
    expect(functionNames(WIZPAY_TESTNET_LEGACY_ABI)).toContain("batchRouteAndPay");
  });
});
