import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type PublicClient,
} from "viem";
import { ERC20_ABI } from "@/constants/erc20";
import {
  ARC_NATIVE_USDC_EVENT_ADDRESS,
  extractCircleTransactionHash,
  extractCircleTransactionId,
  verifyCircleAppWalletTransfer,
  verifyErc20Transfer,
} from "@/lib/send-transaction";

describe("Circle Send transaction correlation", () => {
  it("uses challenge correlation IDs", () => {
    expect(
      extractCircleTransactionId({
        data: { challenge: { correlationIds: ["circle-transaction-id"] } },
      }),
    ).toBe("circle-transaction-id");
  });

  it("does not mistake a challenge ID for a transaction ID", () => {
    expect(
      extractCircleTransactionId({ challengeId: "challenge-only" }),
    ).toBeNull();
  });

  it("extracts only a valid direct transaction hash", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(extractCircleTransactionHash({ data: { txHash: hash } })).toBe(hash);
    expect(
      extractCircleTransactionHash({ data: { txHash: "pending" } }),
    ).toBeNull();
  });

  it("verifies Circle's Arc native USDC Transfer evidence without using the EntryPoint sender", async () => {
    const sender = "0x56DE876C902AdA72CF8E7595715127cEA27d43E6";
    const recipient = "0x32F251fc36A1174901124589EAC2d4E391816F69";
    const event = {
      type: "event",
      name: "Transfer",
      inputs: [
        { indexed: true, name: "from", type: "address" },
        { indexed: true, name: "to", type: "address" },
        { indexed: false, name: "value", type: "uint256" },
      ],
    } as const;
    const client = {
      chain: { id: 5042002 },
      waitForTransactionReceipt: vi
        .fn()
        .mockResolvedValue({
          status: "success",
          logs: [
            {
              address: ARC_NATIVE_USDC_EVENT_ADDRESS,
              topics: encodeEventTopics({
                abi: [event],
                eventName: "Transfer",
                args: { from: sender, to: recipient },
              }),
              data: encodeAbiParameters(
                [{ type: "uint256" }],
                [1_000_000_000_000_000_000n],
              ),
            },
          ],
        }),
      getTransaction: vi
        .fn()
        .mockResolvedValue({
          chainId: 5042002,
          from: `0x${"1".repeat(40)}`,
          to: `0x${"2".repeat(40)}`,
          input: "0x",
        }),
    } as unknown as PublicClient;
    await expect(
      verifyCircleAppWalletTransfer({
        amount: 1_000_000n,
        hash: `0x${"a".repeat(64)}`,
        publicClient: client,
        recipient,
        sender,
        token: "0x3600000000000000000000000000000000000000",
        tokenSymbol: "USDC",
      }),
    ).resolves.toBeTruthy();
  });
});

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
    logAddress?: `0x${string}`;
    recipient?: `0x${string}`;
    status?: "success" | "reverted";
  }) {
    const amount = overrides?.amount ?? 1_000_000n;
    const eventRecipient = overrides?.recipient ?? recipient;
    return {
      chain: { id: 5_042_002 },
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: overrides?.status ?? "success",
        logs: [
          {
            address: overrides?.logAddress ?? token,
            topics: encodeEventTopics({
              abi: [event],
              eventName: "Transfer",
              args: { from: sender, to: eventRecipient },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [amount]),
          },
        ],
      }),
      getTransaction: vi.fn().mockResolvedValue({
        chainId: 5_042_002,
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

  it("accepts only matching transfer calldata and canonical Transfer evidence", async () => {
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
