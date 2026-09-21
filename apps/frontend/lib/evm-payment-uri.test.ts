import { describe, expect, it } from "vitest";

import { USDC_ADDRESS } from "@/constants/addresses";
import { parseEvmPaymentPayload } from "@/lib/evm-payment-uri";
import { activeArcChain } from "@/lib/wagmi";

const recipient = "0x32F251fc36A1174901124589EAC2d4E391816F69";

describe("parseEvmPaymentPayload", () => {
  it("accepts a plain EVM address", () => {
    expect(parseEvmPaymentPayload(recipient)).toMatchObject({ recipient, scanned: true });
  });

  it("strictly parses a supported EIP-681 ERC-20 transfer on Arc Mainnet", () => {
    const result = parseEvmPaymentPayload(`ethereum:${USDC_ADDRESS}@${activeArcChain.id}/transfer?address=${recipient}&uint256=1250000`);
    expect(result).toEqual({ recipient, chainId: activeArcChain.id, token: "USDC", amount: "1.25", scanned: true });
  });

  it.each([
    "https://evil.example/0x32F251fc36A1174901124589EAC2d4E391816F69",
    "javascript:alert(1)",
    "11111111111111111111111111111111",
    "ethereum:0x0000000000000000000000000000000000000000",
    `ethereum:${recipient}@1`,
    `ethereum:0x1111111111111111111111111111111111111111@${activeArcChain.id}/transfer?address=${recipient}&uint256=1`,
    `ethereum:${USDC_ADDRESS}@${activeArcChain.id}/transfer?address=${recipient}&uint256=1&callback=https://evil.example`,
    `ethereum:${USDC_ADDRESS}@9999/transfer?address=${recipient}&uint256=1`,
  ])("rejects unsupported or malicious payload %s", (payload) => {
    expect(() => parseEvmPaymentPayload(payload)).toThrow();
  });
});
