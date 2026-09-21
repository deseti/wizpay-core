import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CROSS_TOKEN_DISABLED_MESSAGE,
  resolvePayrollRoutePolicy,
} from "@/lib/payroll-route-policy";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";

describe("resolvePayrollRoutePolicy", () => {
  it.each([
    [USDC, [USDC]],
    [EURC, [EURC]],
    [USDC, [USDC.toUpperCase().replace("0X", "0x")]],
  ] as const)(
    "keeps %s same-token payroll direct on Arc Mainnet",
    (sourceTokenAddress, targetTokenAddresses) => {
      expect(
        resolvePayrollRoutePolicy({
          network: "arc-mainnet",
          sourceTokenAddress,
          targetTokenAddresses: [...targetTokenAddresses],
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
    [USDC, [USDC, EURC]],
  ] as const)(
    "routes Arc Mainnet external-wallet %s cross-token payroll to the atomic payroll contract",
    (sourceTokenAddress, targetTokenAddresses) => {
      expect(
        resolvePayrollRoutePolicy({
          network: "arc-mainnet",
          sourceTokenAddress,
          targetTokenAddresses: [...targetTokenAddresses],
          crossTokenEnabled: true,
        }),
      ).toEqual({
        kind: "external-wallet-mainnet-atomic",
        requiresQuote: true,
        blockedReason: null,
      });
    },
  );

  it("blocks disabled cross-token payroll on Arc Mainnet", () => {
    expect(
      resolvePayrollRoutePolicy({
        network: "arc-mainnet",
        sourceTokenAddress: USDC,
        targetTokenAddresses: [EURC],
        crossTokenEnabled: false,
      }),
    ).toEqual({
      kind: "cross-token-disabled",
      requiresQuote: false,
      blockedReason: CROSS_TOKEN_DISABLED_MESSAGE,
    });
    expect(CROSS_TOKEN_DISABLED_MESSAGE).toContain("Arc Mainnet");
  });

  it("matches recipients case-insensitively", () => {
    expect(
      resolvePayrollRoutePolicy({
        network: "arc-mainnet",
        sourceTokenAddress: USDC,
        targetTokenAddresses: [USDC.toLowerCase()],
        crossTokenEnabled: false,
      }),
    ).toEqual({
      kind: "direct",
      requiresQuote: false,
      blockedReason: null,
    });
  });
});

describe("payroll quote scheduling boundary", () => {
  it("keeps payroll quoting on the Mainnet route policy and Mainnet swap gate", () => {
    const hookSource = readFileSync(
      resolve(process.cwd(), "hooks/wizpay/index.ts"),
      "utf8",
    );
    const swapScreen = readFileSync(
      resolve(process.cwd(), "components/dashboard/SwapScreen.tsx"),
      "utf8",
    );

    expect(hookSource).toContain("resolvePayrollRoutePolicy");
    expect(hookSource).toContain("useMainnetUniswapV4Gate");
    expect(hookSource.toLowerCase()).not.toContain("xylo" + "net");
    expect(swapScreen).toContain("quoteUserSwap");
    expect(swapScreen).toContain("USER_SWAP_CHAIN");
    expect(swapScreen.toLowerCase()).not.toContain("xylo" + "net");
  });
});
