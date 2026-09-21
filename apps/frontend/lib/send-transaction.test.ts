import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type PublicClient,
} from "viem";
import { ERC20_ABI } from "@/constants/erc20";
import { verifyErc20Transfer } from "@/lib/send-transaction";

describe("External Wallet Send receipt characterization", () => {
  const sender = "0x56DE876C902AdA72CF8E7595715127cEA27d43E6";
  const recipient = "0x32F251fc36A1174901124589EAC2d4E391816F69";
  const token = "0x3600000000000000000000000000000000000000";
  const hash = `0x${"a".repeat(64)}` as const;
  const event = {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  } as const;

  function client(overrides?: {
    amount?: bigint;
    chainId?: number;
    logAddress?: `0x${string}`;
    recipient?: `0x${string}`;
    sender?: `0x${string}`;
    status?: "success" | "reverted";
  }) {
    const amount = overrides?.amount ?? 1_000_000n;
    const eventRecipient = overrides?.recipient ?? recipient;
    const eventSender = overrides?.sender ?? sender;
    return {
      chain: { id: 5_042 },
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: overrides?.status ?? "success",
        logs: [
          {
            address: overrides?.logAddress ?? token,
            topics: encodeEventTopics({
              abi: [event],
              eventName: "Transfer",
              args: { from: eventSender, to: eventRecipient },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [amount]),
          },
        ],
      }),
      getTransaction: vi.fn().mockResolvedValue({
        chainId: overrides?.chainId ?? 5_042,
        from: sender,
        to: token,
        input: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [recipient, 1_000_000n],
        }),
      }),
    } as unknown as PublicClient;
  }

  it("accepts only matching transfer calldata and canonical Transfer evidence on Arc Mainnet", async () => {
    await expect(
      verifyErc20Transfer({
        amount: 1_000_000n,
        hash,
        publicClient: client(),
        recipient,
        sender,
        token,
      }),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["wrong event amount", { amount: 999_999n }],
    [
      "wrong event recipient",
      { recipient: "0x1111111111111111111111111111111111111111" as const },
    ],
    [
      "wrong event contract",
      { logAddress: "0x2222222222222222222222222222222222222222" as const },
    ],
    ["failed receipt", { status: "reverted" as const }],
    ["wrong chain", { chainId: 9_999 }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(
      verifyErc20Transfer({
        amount: 1_000_000n,
        hash,
        publicClient: client(overrides),
        recipient,
        sender,
        token,
      }),
    ).rejects.toThrow();
  });
});
