import { describe, expect, it } from "vitest";
import { ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS } from "@/lib/wizpay";
import { getTokenVisual } from "./token-visuals";

describe("canonical token visuals", () => {
  it("maps Arc USDC and EURC to local PNG assets by chain and address", () => {
    expect(getTokenVisual(ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS.USDC.address)?.iconPath).toBe("/tokens/usdc.png");
    expect(getTokenVisual(ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS.EURC.address)?.iconPath).toBe("/tokens/eurc.png");
  });
  it("matches case-insensitively but never by symbol alone", () => {
    expect(getTokenVisual(ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS.EURC.address.toLowerCase())?.symbol).toBe("EURC");
    expect(getTokenVisual(ARC_TESTNET_CHAIN_ID, "USDC")).toBeNull();
    expect(getTokenVisual(1, SUPPORTED_TOKENS.USDC.address)).toBeNull();
  });
});
