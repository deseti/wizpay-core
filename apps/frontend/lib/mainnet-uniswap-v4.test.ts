import { describe, expect, it } from "vitest";

import {
  ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE,
  getMainnetUniswapV4UnavailableState,
} from "./mainnet-uniswap-v4";

describe("Arc Mainnet Uniswap V4 availability", () => {
  it("exposes official publication metadata without enabling execution", () => {
    const state = getMainnetUniswapV4UnavailableState();
    expect(state.available).toBe(false);
    expect(state.executable).toBe(false);
    expect(state.poolIdentityStatus).toBe("candidate-unverified");
    expect(state.candidatePool.poolId).toBe(state.candidatePool.derivedPoolId);
    expect(state.message).toBe(ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE);
    expect(state.readiness).toMatchObject({
      network: "arc-mainnet",
      chainId: 5_042,
      pair: ["USDC", "EURC"],
      walletControl: ["external-wallet"],
      custody: "user-controlled-only",
      capabilityEnabled: false,
      executable: false,
      poolKey: { status: "candidate", executable: false },
      poolId: { status: "candidate", executable: false },
      poolUniqueness: { status: "unavailable" },
      liquidity: { status: "unavailable" },
      rpcQuorum: { status: "unavailable" },
    });
    expect(Object.isFrozen(state)).toBe(true);
  });
});
