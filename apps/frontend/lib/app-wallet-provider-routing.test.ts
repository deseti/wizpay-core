import { describe, expect, it } from "vitest";

import {
  resolveAppWalletPayrollProvider,
  resolveAutomaticAppWalletProvider,
} from "@/lib/app-wallet-provider-routing";

describe("App Wallet provider routing", () => {
  it.each([
    ["USDC", "EURC", "9999999", "xylonet"],
    ["USDC", "EURC", "10000000", "stablefx"],
    ["EURC", "USDC", "9999999", "xylonet"],
    ["EURC", "USDC", "10000000", "stablefx"],
  ] as const)(
    "routes %s to %s amount %s through %s",
    (sourceToken, targetToken, aggregateAmount, provider) => {
      expect(
        resolveAppWalletPayrollProvider({
          sourceToken,
          targetToken,
          aggregateAmount,
        }),
      ).toBe(provider);
    },
  );

  it("keeps same-token Payroll outside both FX providers", () => {
    expect(
      resolveAppWalletPayrollProvider({
        sourceToken: "USDC",
        targetToken: "USDC",
        aggregateAmount: "1000000",
      }),
    ).toBeNull();
    expect(
      resolveAppWalletPayrollProvider({
        sourceToken: "EURC",
        targetToken: "EURC",
        aggregateAmount: "10000000",
      }),
    ).toBeNull();
  });

  it("preserves the standalone Swap automatic boundary", () => {
    expect(resolveAutomaticAppWalletProvider("1000000")).toBe("xylonet");
    expect(resolveAutomaticAppWalletProvider("9999999")).toBe("xylonet");
    expect(resolveAutomaticAppWalletProvider("10000000")).toBe("stablefx");
  });
});
