import { describe, expect, it } from "vitest";

import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  getExplorerTxUrl,
} from "@/lib/wizpay";

const TX_HASH = `0x${"b".repeat(64)}`;

describe("Arc explorer URL selection", () => {
  it("uses ArcScan testnet for the Arc testnet chain ID", () => {
    expect(getExplorerTxUrl(TX_HASH, ARC_TESTNET_CHAIN_ID)).toBe(
      `https://testnet.arcscan.app/tx/${TX_HASH}`,
    );
  });

  it("does not allow an independent Arc Mainnet explorer override", () => {
    expect(getExplorerTxUrl(TX_HASH, ARC_MAINNET_CHAIN_ID)).toBe(null);
  });

  it("fails closed for an invalid hash or an unconfigured mainnet explorer", () => {
    expect(
      getExplorerTxUrl("circle-transaction-id", ARC_TESTNET_CHAIN_ID),
    ).toBe(null);
    expect(getExplorerTxUrl(TX_HASH, ARC_MAINNET_CHAIN_ID)).toBe(null);
  });

  it("does not default an omitted chain ID to Arc Testnet", () => {
    expect(getExplorerTxUrl(TX_HASH, undefined)).toBe(null);
  });
});
