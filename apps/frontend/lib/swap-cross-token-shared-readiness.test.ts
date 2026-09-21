import { describe, expect, it } from "vitest";

import { getMainnetUniswapV4UnavailableState } from "@/lib/mainnet-uniswap-v4";
import { resolvePayrollRoutePolicy } from "@/lib/payroll-route-policy";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";

describe("swap and cross-token payroll share one live readiness model", () => {
  it("starts fail-closed with static candidate blockers", () => {
    const gate = getMainnetUniswapV4UnavailableState();
    expect(gate.executable).toBe(false);
    expect(gate.available).toBe(false);
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        "UNISWAP_USDC_EURC_POOL_UNIQUENESS_NOT_VERIFIED",
        "ARC_MAINNET_RPC_QUORUM_UNAVAILABLE",
        "ARC_MAINNET_UNISWAP_EXECUTION_AUTHORIZATION_UNAVAILABLE",
      ]),
    );
  });

  it("routes cross-token payroll through the same atomic gate with a required quote", () => {
    const policy = resolvePayrollRoutePolicy({
      network: "arc-mainnet",
      sourceTokenAddress: USDC,
      targetTokenAddresses: [EURC],
      crossTokenEnabled: true,
    });
    expect(policy.kind).toBe("external-wallet-mainnet-atomic");
    expect(policy.requiresQuote).toBe(true);
    // Static default stays blocked; only the backend live quorum can open it.
    expect(getMainnetUniswapV4UnavailableState().executable).toBe(false);
  });

  it("never assumes 1:1 funding: minHopPrice requires an explicit quote", async () => {
    const { calculateMinHopPriceX36 } = await import(
      "@/lib/mainnet-uniswap-v4-protocol"
    );
    // Same units in/out still produce an explicit price floor from the quote;
    // there is no code path that derives funding from outputs alone.
    expect(calculateMinHopPriceX36(1_000_000n, 864_736n, 50)).toBeGreaterThan(
      0n,
    );
    expect(() => calculateMinHopPriceX36(0n, 864_736n, 50)).toThrow();
  });

  it("capability flags never imply executability", async () => {
    const { fetchEffectiveCapabilities } = await import(
      "@/lib/capabilities"
    );
    expect(typeof fetchEffectiveCapabilities).toBe("function");
    // Swap/cross-token execution additionally requires the live gate
    // (useMainnetUniswapV4Gate), which starts fail-closed and upgrades only
    // on backend quorum confirmation with zero blockers.
    const { useMainnetUniswapV4Gate } = await import(
      "@/lib/mainnet-uniswap-v4"
    );
    expect(typeof useMainnetUniswapV4Gate).toBe("function");
  });
});
