import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  getExplorerTxUrl,
} from "@/lib/wizpay";

const TX_HASH = `0x${"b".repeat(64)}`;

describe("Arc explorer URL selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses ArcScan testnet for the Arc testnet chain ID", () => {
    expect(getExplorerTxUrl(TX_HASH, ARC_TESTNET_CHAIN_ID)).toBe(
      `https://testnet.arcscan.app/tx/${TX_HASH}`,
    );
  });

  it("uses the configured production explorer for the Arc mainnet chain ID", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL",
      "https://mainnet-explorer.arc.example/",
    );

    expect(getExplorerTxUrl(TX_HASH, ARC_MAINNET_CHAIN_ID)).toBe(
      `https://mainnet-explorer.arc.example/tx/${TX_HASH}`,
    );
    expect(getExplorerTxUrl(TX_HASH, ARC_MAINNET_CHAIN_ID)).not.toContain(
      "testnet.arcscan.app",
    );
  });

  it("fails closed for an invalid hash or an unconfigured mainnet explorer", () => {
    expect(
      getExplorerTxUrl("circle-transaction-id", ARC_TESTNET_CHAIN_ID),
    ).toBe(null);
    expect(getExplorerTxUrl(TX_HASH, ARC_MAINNET_CHAIN_ID)).toBe(null);
  });
});
