import { describe, expect, it } from "vitest";

import { resolveCanonicalAppWalletEvmAddress } from "./canonical-app-wallet";

const ADDRESS = "0x32F251fc36A1174901124589EAC2d4E391816F69";

describe("resolveCanonicalAppWalletEvmAddress", () => {
  it("returns the one canonical EVM address when network records agree", () => {
    expect(
      resolveCanonicalAppWalletEvmAddress(ADDRESS, ADDRESS.toLowerCase()),
    ).toEqual({ address: ADDRESS, mismatch: false });
  });

  it("fails closed when network records differ", () => {
    expect(
      resolveCanonicalAppWalletEvmAddress(
        ADDRESS,
        "0x1111111111111111111111111111111111111111",
      ),
    ).toEqual({ address: null, mismatch: true });
  });
});
