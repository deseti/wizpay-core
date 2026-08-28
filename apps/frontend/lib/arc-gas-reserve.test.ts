import { describe, expect, it } from "vitest";

import {
  ARC_GAS_FALLBACK_UNITS,
  calculateArcMaxAmount,
  gasReserveFromFeeWei,
  hasArcGasForAmount,
  readCircleFeeEstimateWei,
  sumGasReserves,
} from "./arc-gas-reserve";

describe("Arc native-USDC gas reservation", () => {
  it("uses bigint fee arithmetic and leaves gas from the observed 5.9891 USDC balance", () => {
    const feeWei = readCircleFeeEstimateWei({ medium: { gasLimit: "100000", maxFee: "0.02" } });
    expect(feeWei).toBe(2_000_000_000_000n);
    const reserve = gasReserveFromFeeWei(feeWei).reserveUnits;
    const max = calculateArcMaxAmount({ inputBalance: 5_989_100n, nativeUsdcBalance: 5_989_100n, reserveUnits: reserve, tokenIsUsdc: true });
    expect(max).toBeLessThan(5_989_093n);
    expect(max + reserve).toBe(5_989_100n);
  });

  it("never returns a negative Max for a very small balance", () => {
    expect(calculateArcMaxAmount({ inputBalance: 10_000n, nativeUsdcBalance: 10_000n, reserveUnits: 100_000n, tokenIsUsdc: true })).toBe(0n);
    expect(hasArcGasForAmount({ amountUnits: 1n, inputBalance: 10_000n, nativeUsdcBalance: 10_000n, reserveUnits: 100_000n, tokenIsUsdc: true })).toBe(false);
  });

  it("uses the conservative fallback and never selects a full USDC balance", () => {
    expect(gasReserveFromFeeWei(null)).toEqual({ reserveUnits: ARC_GAS_FALLBACK_UNITS, source: "fallback" });
    expect(calculateArcMaxAmount({ inputBalance: 1_000_000n, nativeUsdcBalance: 1_000_000n, reserveUnits: ARC_GAS_FALLBACK_UNITS, tokenIsUsdc: true })).toBe(900_000n);
    expect(sumGasReserves([1n, null]).reserveUnits).toBe(ARC_GAS_FALLBACK_UNITS);
  });

  it("allows full EURC input only when separate native USDC covers gas", () => {
    expect(calculateArcMaxAmount({ inputBalance: 2_000_000n, nativeUsdcBalance: 100_000n, reserveUnits: 50_000n, tokenIsUsdc: false })).toBe(2_000_000n);
    expect(calculateArcMaxAmount({ inputBalance: 2_000_000n, nativeUsdcBalance: 49_999n, reserveUnits: 50_000n, tokenIsUsdc: false })).toBe(0n);
  });
});
