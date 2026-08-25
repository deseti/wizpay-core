import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRIDGE_AMOUNT,
  isBridgeAmountLocked,
  parseBridgeAmount,
} from "./bridge-amount";

describe("bridge amount", () => {
  it("defaults to and accepts an edited 1 USDC amount", () => {
    expect(parseBridgeAmount(DEFAULT_BRIDGE_AMOUNT).amountUnits).toBe(
      1_000_000n,
    );
    expect(parseBridgeAmount("10").amountUnits).toBe(10_000_000n);
    expect(parseBridgeAmount("1").amountUnits).toBe(1_000_000n);
  });

  it("rejects invalid, zero, and over-precise values", () => {
    for (const value of ["", "abc", "-1", "0", "0.0000000", "1.0000001"]) {
      expect(parseBridgeAmount(value).amountUnits).toBeNull();
    }
    expect(parseBridgeAmount("1.000001").amountUnits).toBe(1_000_001n);
  });

  it("locks only while the intent is in an active or confirmed lifecycle", () => {
    expect(
      isBridgeAmountLocked({
        busy: false,
        approvalConfirmed: false,
        sourceBurnConfirmed: false,
      }),
    ).toBe(false);
    expect(
      isBridgeAmountLocked({
        busy: true,
        approvalConfirmed: false,
        sourceBurnConfirmed: false,
      }),
    ).toBe(true);
    expect(
      isBridgeAmountLocked({
        busy: false,
        approvalConfirmed: true,
        sourceBurnConfirmed: false,
      }),
    ).toBe(true);
    expect(
      isBridgeAmountLocked({
        busy: false,
        approvalConfirmed: false,
        sourceBurnConfirmed: true,
      }),
    ).toBe(true);
  });
});
