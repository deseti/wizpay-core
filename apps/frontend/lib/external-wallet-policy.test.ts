import { describe, expect, it, vi } from "vitest";

import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";
import {
  assertInitiatingWalletAuthority,
  assertSelectedArcWalletChain,
  assertSupportedExternalWalletChain,
  requestExternalWalletChain,
  SUPPORTED_EXTERNAL_WALLET_CHAIN_IDS,
} from "@/lib/external-wallet-policy";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

describe("external wallet policy", () => {
  it("supports only Arc Mainnet", () => {
    expect(ACTIVE_ARC_NETWORK.key).toBe("arc-mainnet");
    expect([...SUPPORTED_EXTERNAL_WALLET_CHAIN_IDS]).toEqual([5_042]);
    expect(SUPPORTED_EXTERNAL_WALLET_CHAIN_IDS).not.toContain(9_999);
  });

  it("rejects unsupported chain IDs", () => {
    expect(() => assertSupportedExternalWalletChain(1)).toThrow(
      "Unsupported wallet chain ID: 1",
    );
    expect(() => assertSupportedExternalWalletChain(9_999)).toThrow(
      "Unsupported wallet chain ID: 9999",
    );
    expect(() => assertSelectedArcWalletChain(9_999)).toThrow(
      "chain 5042",
    );
  });

  it("requests exactly the selected chain without a fallback", async () => {
    const switchChain = vi.fn().mockResolvedValue(undefined);
    await requestExternalWalletChain({
      currentChainId: 1,
      targetChainId: ACTIVE_ARC_NETWORK.chainId,
      switchChain,
    });
    expect(switchChain).toHaveBeenCalledOnce();
    expect(switchChain).toHaveBeenCalledWith({
      chainId: ACTIVE_ARC_NETWORK.chainId,
    });
  });

  it("fails closed when the wallet rejects network switching", async () => {
    await expect(
      requestExternalWalletChain({
        currentChainId: 1,
        targetChainId: ACTIVE_ARC_NETWORK.chainId,
        switchChain: vi
          .fn()
          .mockRejectedValue(new Error("User rejected: 4001")),
      }),
    ).rejects.toThrow("Network switch was rejected in your wallet.");
  });

  it("keeps sender and recipient authority with the initiating wallet", () => {
    expect(() =>
      assertInitiatingWalletAuthority({
        initiatingWallet: WALLET,
        connectedWallet: WALLET,
        clientAccount: WALLET,
      }),
    ).not.toThrow();
    expect(() =>
      assertInitiatingWalletAuthority({
        initiatingWallet: WALLET,
        connectedWallet: OTHER_WALLET,
        clientAccount: WALLET,
      }),
    ).toThrow("no longer matches the initiating wallet");
  });
});
