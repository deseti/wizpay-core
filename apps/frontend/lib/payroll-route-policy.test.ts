import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePayrollRoutePolicy } from "@/lib/payroll-route-policy";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

describe("resolvePayrollRoutePolicy", () => {
  it.each([
    ["external", USDC, [USDC]],
    ["external", EURC, [EURC]],
    ["circle", USDC, [USDC.toUpperCase().replace("0X", "0x")]],
    ["circle", EURC, [EURC]],
  ] as const)(
    "keeps %s %s same-token payroll direct",
    (walletMode, sourceTokenAddress, targetTokenAddresses) => {
      expect(
        resolvePayrollRoutePolicy({
          walletMode,
          network: "arc-testnet",
          sourceTokenAddress,
          targetTokenAddresses,
          crossTokenEnabled: true,
        }),
      ).toEqual({
        kind: "direct",
        requiresQuote: false,
        blockedReason: null,
      });
    },
  );

  it.each([
    [USDC, [EURC]],
    [EURC, [USDC]],
  ] as const)(
    "routes App Wallet %s cross-token payroll through XyloNet",
    (sourceTokenAddress, targetTokenAddresses) => {
      expect(
        resolvePayrollRoutePolicy({
          walletMode: "circle",
          network: "arc-testnet",
          sourceTokenAddress,
          targetTokenAddresses,
          crossTokenEnabled: true,
        }),
      ).toEqual({
        kind: "app-wallet-xylonet",
        requiresQuote: true,
        blockedReason: null,
      });
    },
  );

  it.each([
    [USDC, [EURC]],
    [EURC, [USDC]],
    [USDC, [USDC, EURC]],
  ] as const)(
    "routes External Wallet %s cross-token or mixed payroll through XyloNet",
    (sourceTokenAddress, targetTokenAddresses) => {
      expect(
        resolvePayrollRoutePolicy({
          walletMode: "external",
          network: "arc-testnet",
          sourceTokenAddress,
          targetTokenAddresses,
          crossTokenEnabled: true,
        }),
      ).toEqual({
        kind: "external-wallet-xylonet",
        requiresQuote: true,
        blockedReason: null,
      });
    },
  );

  it.each([
    ["arc-mainnet", true],
    ["arc-testnet", false],
  ] as const)(
    "blocks cross-token payroll on %s when capability is %s without quotes",
    (network, crossTokenEnabled) => {
      expect(
        resolvePayrollRoutePolicy({
          walletMode: "circle",
          network,
          sourceTokenAddress: USDC,
          targetTokenAddresses: [EURC],
          crossTokenEnabled,
        }),
      ).toEqual({
        kind: "cross-token-disabled",
        requiresQuote: false,
        blockedReason:
          "Cross-token payments are unavailable on the selected Arc network.",
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
