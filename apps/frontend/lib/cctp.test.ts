import { describe, expect, it } from "vitest";
import { getAddress, type Chain } from "viem";
import {
  addressToBytes32,
  bridgeChain,
  CCTP_MAX_BURN_AMOUNT_UNITS,
  CCTP_STANDARD_FINALITY_THRESHOLD,
  explorerTxUrl,
  wagmiChainForBridge,
} from "@/lib/cctp";

const ARC_CHAIN = { id: 5042 } as Chain;

describe("CCTP production helpers", () => {
  it("uses Standard Transfer finality and the official single-burn limit", () => {
    expect(CCTP_STANDARD_FINALITY_THRESHOLD).toBe(2000);
    expect(CCTP_MAX_BURN_AMOUNT_UNITS).toBe(10_000_000_000_000n);
  });

  it("treats Arc Mainnet as a first-class route with domain 26", () => {
    const arc = bridgeChain("ARC-MAINNET");
    expect(arc.chainId).toBe(5042);
    expect(arc.domain).toBe(26);
    expect(arc.tokenMessengerV2).toBe(
      "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    );
    expect(arc.messageTransmitterV2).toBe(
      "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    );
  });

  it("converts addresses to bytes32 for CCTP mint recipients", () => {
    expect(
      addressToBytes32(getAddress("0x1111111111111111111111111111111111111111")),
    ).toBe(
      "0x0000000000000000000000001111111111111111111111111111111111111111",
    );
  });

  it("builds explorer transaction URLs per bridge chain", () => {
    const arc = bridgeChain("ARC-MAINNET");
    expect(explorerTxUrl(arc, `0x${"11".repeat(32)}`)).toBe(
      `https://explorer.arc.io/tx/0x${"11".repeat(32)}`,
    );
    expect(explorerTxUrl(arc, "not-a-hash")).toBeNull();
  });

  it("resolves Arc through the app chain and rejects unknown codes", () => {
    expect(wagmiChainForBridge("ARC-MAINNET", ARC_CHAIN).id).toBe(5042);
    expect(wagmiChainForBridge("BASE-MAINNET", ARC_CHAIN).id).toBe(8453);
    expect(() => wagmiChainForBridge("BASE-SEPOLIA", ARC_CHAIN)).toThrow();
  });
});
