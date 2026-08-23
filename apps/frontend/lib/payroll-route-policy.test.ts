import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePayrollRoutePolicy } from "@/lib/payroll-route-policy";

describe("resolvePayrollRoutePolicy", () => {
  it.each([
    ["external", "USDC", ["USDC"]],
    ["external", "EURC", ["EURC"]],
    ["circle", "USDC", ["USDC"]],
    ["circle", "EURC", ["EURC"]],
  ] as const)(
    "keeps %s %s same-token payroll direct",
    (walletMode, sourceToken, targetTokens) => {
      expect(
        resolvePayrollRoutePolicy({ walletMode, sourceToken, targetTokens }),
      ).toEqual({
        kind: "direct",
        requiresQuote: false,
        blockedReason: null,
      });
    },
  );

  it.each([
    ["USDC", ["EURC"]],
    ["EURC", ["USDC"]],
  ] as const)(
    "routes App Wallet %s cross-token payroll through XyloNet",
    (sourceToken, targetTokens) => {
      expect(
        resolvePayrollRoutePolicy({
          walletMode: "circle",
          sourceToken,
          targetTokens,
        }),
      ).toEqual({
        kind: "app-wallet-xylonet",
        requiresQuote: true,
        blockedReason: null,
      });
    },
  );

  it.each([
    ["USDC", ["EURC"]],
    ["EURC", ["USDC"]],
    ["USDC", ["USDC", "EURC"]],
  ] as const)(
    "routes External Wallet %s cross-token or mixed payroll through XyloNet",
    (sourceToken, targetTokens) => {
      expect(
        resolvePayrollRoutePolicy({
          walletMode: "external",
          sourceToken,
          targetTokens,
        }),
      ).toEqual({
        kind: "external-wallet-xylonet",
        requiresQuote: true,
        blockedReason: null,
      });
    },
  );
});

describe("payroll quote scheduling boundary", () => {
  it("keeps both wallet modes on XyloNet quote clients", () => {
    const hookSource = readFileSync(
      resolve(process.cwd(), "hooks/wizpay/index.ts"),
      "utf8",
    );

    expect(hookSource).toContain("quoteAppWalletXylonetSwap(");
    expect(hookSource).toContain("quoteUserSwap(");
    expect(hookSource).toContain("runExternalPayrollXylonetSwap(");
  });
});
