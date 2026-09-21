import { describe, expect, it } from "vitest";

import {
  BRIDGE_FAST_UNAVAILABLE_MESSAGE,
  formatUsdcUnits,
} from "./BridgeScreen";

describe("bridge quote display", () => {
  it("formats 6-decimal USDC units", () => {
    expect(formatUsdcUnits(10_000n)).toBe("0.01");
    expect(formatUsdcUnits(100n)).toBe("0.0001");
    expect(formatUsdcUnits(0n)).toBe("0");
  });

  it("exposes the fast-unavailable fail-closed message", () => {
    expect(BRIDGE_FAST_UNAVAILABLE_MESSAGE).toBe(
      "Fast CCTP transfer is temporarily unavailable for this route.",
    );
  });
});
