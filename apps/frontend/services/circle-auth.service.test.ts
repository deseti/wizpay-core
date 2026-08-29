import { describe, expect, it } from "vitest";

import {
  circleBalanceAmountToUnits,
  normalizeCircleWalletTokenBalance,
  selectCircleTransferToken,
} from "./circle-auth.service";

describe("Circle transfer token selection", () => {
  const balances = [
    {
      amount: "0",
      token: {
        blockchain: "ARC-TESTNET",
        decimals: 6,
        id: "legacy-usdc",
        isNative: false,
        symbol: "USDC",
        tokenAddress: "0x1111111111111111111111111111111111111111",
      },
    },
    {
      amount: "5.989093812345678901",
      token: {
        blockchain: "ARC-TESTNET",
        decimals: 18,
        id: "arc-usdc",
        isNative: true,
        symbol: "USDC",
        tokenAddress: "0x2222222222222222222222222222222222222222",
      },
    },
  ].map(normalizeCircleWalletTokenBalance);

  it("uses the configured Arc token address before a duplicated symbol", () => {
    const selected = selectCircleTransferToken(
      balances.filter((entry) => entry !== null),
      {
        blockchain: "ARC-TESTNET",
        symbol: "USDC",
        tokenAddress: "0x2222222222222222222222222222222222222222",
      },
    );
    expect(selected).toMatchObject({
      blockchain: "ARC-TESTNET",
      decimals: 18,
      isNative: true,
      tokenId: "arc-usdc",
    });
  });

  it("fails closed when a symbol-only fallback is ambiguous", () => {
    expect(
      selectCircleTransferToken(
        balances.filter((entry) => entry !== null),
        {
          blockchain: "ARC-TESTNET",
          symbol: "USDC",
          tokenAddress: "0x3333333333333333333333333333333333333333",
        },
      ),
    ).toBeNull();
  });

  it("conservatively handles native Arc gas dust beyond token display precision", () => {
    expect(circleBalanceAmountToUnits("5.989093812345678901", 6)).toBe(
      5_989_093n,
    );
  });
});
