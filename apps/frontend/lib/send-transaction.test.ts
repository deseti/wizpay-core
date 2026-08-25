import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type PublicClient } from "viem";
import { ARC_NATIVE_USDC_EVENT_ADDRESS, extractCircleTransactionHash, extractCircleTransactionId, verifyCircleAppWalletTransfer } from "@/lib/send-transaction";

describe("Circle Send transaction correlation", () => {
  it("uses challenge correlation IDs", () => {
    expect(extractCircleTransactionId({ data: { challenge: { correlationIds: ["circle-transaction-id"] } } })).toBe("circle-transaction-id");
  });

  it("does not mistake a challenge ID for a transaction ID", () => {
    expect(extractCircleTransactionId({ challengeId: "challenge-only" })).toBeNull();
  });

  it("extracts only a valid direct transaction hash", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(extractCircleTransactionHash({ data: { txHash: hash } })).toBe(hash);
    expect(extractCircleTransactionHash({ data: { txHash: "pending" } })).toBeNull();
  });

  it("verifies Circle's Arc native USDC Transfer evidence without using the EntryPoint sender", async () => {
    const sender = "0x56DE876C902AdA72CF8E7595715127cEA27d43E6";
    const recipient = "0x32F251fc36A1174901124589EAC2d4E391816F69";
    const event = { type: "event", name: "Transfer", inputs: [{ indexed: true, name: "from", type: "address" }, { indexed: true, name: "to", type: "address" }, { indexed: false, name: "value", type: "uint256" }] } as const;
    const client = { chain: { id: 5042002 }, waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [{ address: ARC_NATIVE_USDC_EVENT_ADDRESS, topics: encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: sender, to: recipient } }), data: encodeAbiParameters([{ type: "uint256" }], [1_000_000_000_000_000_000n]) }] }), getTransaction: vi.fn().mockResolvedValue({ chainId: 5042002, from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, input: "0x" }) } as unknown as PublicClient;
    await expect(verifyCircleAppWalletTransfer({ amount: 1_000_000n, hash: `0x${"a".repeat(64)}`, publicClient: client, recipient, sender, token: "0x3600000000000000000000000000000000000000", tokenSymbol: "USDC" })).resolves.toBeTruthy();
  });
});
