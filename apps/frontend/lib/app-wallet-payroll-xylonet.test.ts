import { describe, expect, it } from "vitest";

import { readVerifiedXylonetPayrollOutput } from "@/lib/app-wallet-payroll-xylonet";
import type { AppWalletXylonetOperationResponse } from "@/lib/app-wallet-swap-service";

const wallet = "0x1111111111111111111111111111111111111111";
const route = {
  sourceToken: "USDC" as const,
  targetToken: "EURC" as const,
  amountIn: "1020000",
  walletAddress: wallet,
};
const completed = {
  provider: "xylonet",
  executionMode: "direct-user-controlled",
  lifecycleStage: "completed",
  terminalStatus: "confirmed",
  tokenIn: "USDC",
  tokenOut: "EURC",
  amountIn: "1020000",
  expectedOutput: "997000",
  minimumOutput: "977060",
  walletAddress: wallet,
  recipientAddress: wallet,
  verifiedActualOutput: "987654",
} as AppWalletXylonetOperationResponse;

describe("confirmed XyloNet Payroll output", () => {
  it("accepts receipt-verified output for the exact route", () => {
    expect(readVerifiedXylonetPayrollOutput(completed, route)).toBe("987654");
  });

  it.each([undefined, "0", "1.2", "bad"])(
    "rejects malformed or zero actual output %s",
    (verifiedActualOutput) => {
      expect(() => readVerifiedXylonetPayrollOutput(
        { ...completed, verifiedActualOutput }, route,
      )).toThrow("output validation failed");
    },
  );

  it("rejects the wrong output token", () => {
    expect(() => readVerifiedXylonetPayrollOutput(
      { ...completed, tokenOut: "USDC" }, route,
    )).toThrow("operation validation failed");
  });

  it("rejects an unconfirmed operation", () => {
    expect(() => readVerifiedXylonetPayrollOutput(
      { ...completed, terminalStatus: undefined }, route,
    )).toThrow("output validation failed");
  });
});
