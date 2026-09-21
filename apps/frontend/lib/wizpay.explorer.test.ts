import { describe, expect, it } from "vitest";

import {
  ARC_MAINNET_CHAIN_ID,
  getExplorerTxUrl,
} from "@/lib/wizpay";

const TX_HASH = `0x${"b".repeat(64)}`;

describe("Arc explorer URL selection", () => {
  it("uses the Arc Mainnet explorer for the Arc Mainnet chain ID", () => {
    expect(getExplorerTxUrl(TX_HASH, ARC_MAINNET_CHAIN_ID)).toBe(
      `https://explorer.arc.io/tx/${TX_HASH}`,
    );
  });

  it("fails closed for legacy or unknown chain IDs", () => {
    expect(getExplorerTxUrl(TX_HASH, 9_999)).toBe(null);
    expect(getExplorerTxUrl(TX_HASH, 1)).toBe(null);
  });

  it("fails closed for an invalid hash", () => {
    expect(
      getExplorerTxUrl("legacy-transaction-id", ARC_MAINNET_CHAIN_ID),
    ).toBe(null);
  });

  it("does not default an omitted chain ID", () => {
    expect(getExplorerTxUrl(TX_HASH, undefined)).toBe(null);
  });
});
