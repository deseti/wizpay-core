import { describe, expect, it } from "vitest";
import { WIZPAY_ABI, WIZPAY_MAINNET_ABI } from "./abi";

describe("WizPay Mainnet payroll receipt ABI", () => {
  it("routes the shared ABI to PayrollMainnet with the exact reference event", () => {
    expect(WIZPAY_ABI).toBe(WIZPAY_MAINNET_ABI);
    const referenceConsumed = (
      WIZPAY_ABI as unknown as Array<{
        type: string;
        name?: string;
        inputs?: Array<{ name: string }>;
      }>
    ).find(
      (entry) => entry.type === "event" && entry.name === "PayrollReferenceConsumed",
    );
    expect(
      referenceConsumed?.inputs?.map((input) => input.name),
    ).toEqual([
      "referenceHash",
      "employer",
      "tokenIn",
      "tokenOut",
      "batchDigest",
      "totalInput",
      "totalOutput",
      "totalFees",
      "recipientCount",
      "referenceId",
    ]);
    const eventNames = (
      WIZPAY_ABI as unknown as Array<{ type: string; name?: string }>
    )
      .filter((entry) => entry.type === "event")
      .map((entry) => entry.name);
    expect(eventNames).not.toContain("DirectUsdcPayment");
    expect(eventNames).not.toContain("BatchPaymentRouted");
  });

  it("exposes Mainnet payroll execution without legacy reads", () => {
    const functionNames = (
      abi: readonly { type: string; name?: string }[],
    ) => abi.filter((entry) => entry.type === "function").map((entry) => entry.name);
    expect(functionNames(WIZPAY_MAINNET_ABI)).not.toContain("fxEngine");
    expect(functionNames(WIZPAY_MAINNET_ABI)).not.toContain("getEstimatedOutput");
    expect(functionNames(WIZPAY_MAINNET_ABI)).not.toContain("batchRouteAndPay");
    expect(functionNames(WIZPAY_MAINNET_ABI)).toContain("executeSameTokenPayroll");
    expect(functionNames(WIZPAY_MAINNET_ABI)).toContain("executeCrossTokenPayroll");
  });
});
