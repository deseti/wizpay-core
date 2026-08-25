import { describe, expect, it, vi } from "vitest";
import {
  concatHex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  numberToHex,
  padHex,
  parseAbiParameters,
  type Address,
  type Hex,
  type Transaction,
  type TransactionReceipt,
} from "viem";
import { getBridgeTestnet } from "@wizpay/bridge-registry";
import {
  CCTP_V2_RECOVERY_KEY,
  CCTP_DESTINATION_LOG_CHUNK_SIZE,
  CCTP_MESSAGE_TRANSMITTER_V2_ABI,
  CCTP_ERC20_ABI,
  addressToBytes32,
  decodeCctpV2Message,
  discoverDestinationCompletion,
  fetchIrisMessages,
  persistDestinationTransactionHash,
  readDirectBridgeRecovery,
  readNonceState,
  submitAndVerifyDestinationMint,
  validateBridgeRequest,
  verifyIrisMessage,
  verifyKnownDestinationCompletion,
  withBridgeSubmissionLock,
  writeDirectBridgeRecovery,
} from "./cctp-v2";

const WALLET = "0x32F251fc36A1174901124589EAC2d4E391816F69" as Address;
const ZERO_NONCE = `0x${"00".repeat(32)}` as Hex;
const LIVE_NONCE = `0x${"12".repeat(32)}` as Hex;
const EXISTING_BURN =
  "0x41f70ff0202c7611a465bf0e44a2a2274a6be2554256c3d7b63375fc53b2e64e" as Hex;
const DESTINATION_HASH = `0x${"ab".repeat(32)}` as Hex;

function u32(value: number) {
  return numberToHex(value, { size: 4 });
}
function u256(value: bigint) {
  return numberToHex(value, { size: 32 });
}
function message(input: {
  nonce: Hex;
  finality: number;
  destinationDomain?: number;
  recipient?: Address;
  caller?: Address;
  burnToken?: Address;
  amount?: bigint;
  destinationCode?: "BASE-SEPOLIA" | "ETH-SEPOLIA";
}) {
  const source = getBridgeTestnet("ARC-TESTNET");
  const destination = getBridgeTestnet(input.destinationCode ?? "BASE-SEPOLIA");
  const recipient = input.recipient ?? WALLET;
  return concatHex([
    u32(1),
    u32(source.cctpDomain),
    u32(input.destinationDomain ?? destination.cctpDomain),
    input.nonce,
    addressToBytes32(source.tokenMessengerV2),
    addressToBytes32(destination.tokenMessengerV2),
    addressToBytes32(input.caller ?? WALLET),
    u32(2000),
    u32(input.finality),
    u32(1),
    addressToBytes32(input.burnToken ?? source.usdcAddress),
    addressToBytes32(recipient),
    u256(input.amount ?? 10_000_000n),
    addressToBytes32(WALLET),
    u256(0n),
    u256(0n),
    u256(0n),
  ]);
}

function destinationFixture() {
  const source = getBridgeTestnet("ARC-TESTNET");
  const destination = getBridgeTestnet("ETH-SEPOLIA");
  const attestedMessage = message({
    nonce: LIVE_NONCE,
    finality: 2000,
    destinationCode: "ETH-SEPOLIA",
  });
  const attestation = padHex("0x1234", { size: 65 });
  const decoded = decodeCctpV2Message(attestedMessage);
  const transfer = {
    recovery: {
      cctpVersion: 2 as const,
      sourceChainId: source.chainId,
      sourceDomain: source.cctpDomain,
      destinationChainId: destination.chainId,
      destinationDomain: destination.cctpDomain,
      sourceTransactionHash: EXISTING_BURN,
      walletAddress: WALLET,
      createdAt: "2026-08-24T00:00:00.000Z",
    },
    source,
    destination,
    sourceMessage: message({
      nonce: ZERO_NONCE,
      finality: 0,
      destinationCode: "ETH-SEPOLIA",
    }),
    message: attestedMessage,
    attestation,
    decoded,
  };
  const transaction = {
    hash: DESTINATION_HASH,
    from: WALLET,
    to: destination.messageTransmitterV2,
    input: encodeFunctionData({
      abi: CCTP_MESSAGE_TRANSMITTER_V2_ABI,
      functionName: "receiveMessage",
      args: [attestedMessage, attestation],
    }),
  } as Transaction;
  const messageReceived = {
    address: destination.messageTransmitterV2,
    data: encodeAbiParameters(parseAbiParameters("uint32, bytes32, bytes"), [
      source.cctpDomain,
      addressToBytes32(source.tokenMessengerV2),
      decoded.messageBody,
    ]),
    topics: encodeEventTopics({
      abi: CCTP_MESSAGE_TRANSMITTER_V2_ABI,
      eventName: "MessageReceived",
      args: {
        caller: WALLET,
        nonce: LIVE_NONCE,
        finalityThresholdExecuted: 2000,
      },
    }),
    transactionHash: DESTINATION_HASH,
  };
  const mintTransfer = {
    address: destination.usdcAddress,
    data: encodeAbiParameters(parseAbiParameters("uint256"), [10_000_000n]),
    topics: encodeEventTopics({
      abi: CCTP_ERC20_ABI,
      eventName: "Transfer",
      args: {
        from: "0x0000000000000000000000000000000000000000",
        to: WALLET,
      },
    }),
    transactionHash: DESTINATION_HASH,
  };
  const receipt = {
    status: "success",
    transactionHash: DESTINATION_HASH,
    logs: [messageReceived, mintTransfer],
  } as TransactionReceipt;
  return { transfer, transaction, receipt };
}

describe("browser-direct CCTP V2 policy", () => {
  it.each([
    "ETH-SEPOLIA",
    "BASE-SEPOLIA",
    "ARB-SEPOLIA",
    "OP-SEPOLIA",
    "MONAD-TESTNET",
  ])(
    "accepts registry-driven Arc Standard Transfer to %s",
    (destinationCode) => {
      const route = validateBridgeRequest({
        sourceCode: "ARC-TESTNET",
        destinationCode,
        walletAddress: WALLET,
        recipientAddress: WALLET,
        amount: 1_000_000n,
        maxFee: 0n,
      });
      expect(route.source.finalityThreshold).toBe(2000);
      expect(route.destination.code).toBe(destinationCode);
    },
  );

  it("decodes and validates the existing Arc to Base transfer layout", () => {
    const source = getBridgeTestnet("ARC-TESTNET");
    const destination = getBridgeTestnet("BASE-SEPOLIA");
    const sourceMessage = message({ nonce: ZERO_NONCE, finality: 0 });
    const attested = message({ nonce: LIVE_NONCE, finality: 2000 });
    const verified = verifyIrisMessage({
      source,
      destination,
      walletAddress: WALLET,
      sourceMessage,
      messages: [
        {
          status: "complete",
          cctpVersion: 2,
          eventNonce: LIVE_NONCE,
          message: attested,
          attestation: padHex("0x1234", { size: 65 }),
        },
      ],
    });
    expect(verified.decoded.amount).toBe(10_000_000n);
    expect(verified.decoded.destinationDomain).toBe(6);
    expect(verified.decoded.mintRecipient).toBe(WALLET);
  });

  it.each([
    ["destination domain", { destinationDomain: 0 }],
    [
      "recipient",
      { recipient: "0x1111111111111111111111111111111111111111" as Address },
    ],
    [
      "destination caller",
      { caller: "0x1111111111111111111111111111111111111111" as Address },
    ],
    [
      "burn token",
      { burnToken: "0x1111111111111111111111111111111111111111" as Address },
    ],
    ["amount", { amount: 9_000_000n }],
  ])("rejects wrong %s", (_name, override) => {
    const source = getBridgeTestnet("ARC-TESTNET");
    const destination = getBridgeTestnet("BASE-SEPOLIA");
    expect(() =>
      verifyIrisMessage({
        source,
        destination,
        walletAddress: WALLET,
        sourceMessage: message({ nonce: ZERO_NONCE, finality: 0 }),
        messages: [
          {
            status: "complete",
            cctpVersion: 2,
            eventNonce: LIVE_NONCE,
            message: message({
              nonce: LIVE_NONCE,
              finality: 2000,
              ...override,
            }),
            attestation: padHex("0x1234", { size: 65 }),
          },
        ],
      }),
    ).toThrow();
  });

  it("stores only the minimal confirmed-burn recovery identity", () => {
    const record = {
      cctpVersion: 2 as const,
      sourceChainId: 5_042_002,
      sourceDomain: 26,
      destinationChainId: 84_532,
      destinationDomain: 6,
      sourceTransactionHash: EXISTING_BURN,
      walletAddress: WALLET,
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    writeDirectBridgeRecovery(record);
    expect(readDirectBridgeRecovery()).toEqual(record);
    expect(
      Object.keys(JSON.parse(localStorage.getItem(CCTP_V2_RECOVERY_KEY)!)),
    ).toEqual(Object.keys(record));
  });

  it.each([0n, 1n])(
    "reads destination usedNonces=%s without a signer",
    async (used) => {
      const destination = getBridgeTestnet("BASE-SEPOLIA");
      const client = {
        getChainId: vi.fn().mockResolvedValue(destination.chainId),
        readContract: vi.fn().mockResolvedValue(used),
      };
      await expect(
        readNonceState(client as never, destination, LIVE_NONCE),
      ).resolves.toBe(used);
      expect(client.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: destination.messageTransmitterV2,
          functionName: "usedNonces",
          args: [LIVE_NONCE],
        }),
      );
    },
  );

  it("strictly verifies the exact submitted Ethereum Sepolia receipt without log discovery", async () => {
    const { transfer, transaction, receipt } = destinationFixture();
    const getLogs = vi.fn();
    const client = {
      getChainId: vi.fn().mockResolvedValue(transfer.destination.chainId),
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getTransaction: vi.fn().mockResolvedValue(transaction),
      readContract: vi.fn().mockResolvedValue(1n),
      getLogs,
    };
    const completed = await verifyKnownDestinationCompletion(
      [client as never],
      transfer,
      DESTINATION_HASH,
    );
    expect(completed.destinationTransactionHash).toBe(DESTINATION_HASH);
    expect(completed.evidence).toEqual({
      amount: 10_000_000n,
      recipient: WALLET,
      token: transfer.destination.usdcAddress,
    });
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("persists the destination hash before waiting for its exact receipt", async () => {
    const { transfer, transaction, receipt } = destinationFixture();
    const order: string[] = [];
    const client = {
      getChainId: vi.fn().mockResolvedValue(transfer.destination.chainId),
      readContract: vi.fn().mockResolvedValueOnce(0n).mockResolvedValueOnce(1n),
      waitForTransactionReceipt: vi.fn().mockImplementation(async () => {
        order.push("wait");
        expect(readDirectBridgeRecovery()?.destinationTransactionHash).toBe(
          DESTINATION_HASH,
        );
        return receipt;
      }),
      getTransaction: vi.fn().mockResolvedValue(transaction),
    };
    const completed = await submitAndVerifyDestinationMint({
      client: client as never,
      transfer,
      submit: vi.fn().mockImplementation(async () => {
        order.push("submit");
        return DESTINATION_HASH;
      }),
      onPersisted: () => order.push("persist"),
    });
    expect(order).toEqual(["submit", "persist", "wait"]);
    expect(completed.recovery.destinationTransactionHash).toBe(
      DESTINATION_HASH,
    );
  });

  it("restores a completed mint identity after refresh", () => {
    const { transfer } = destinationFixture();
    persistDestinationTransactionHash(transfer.recovery, DESTINATION_HASH);
    expect(readDirectBridgeRecovery()).toEqual({
      ...transfer.recovery,
      destinationTransactionHash: DESTINATION_HASH,
    });
  });

  it("blocks duplicate receiveMessage submission when the nonce is already used", async () => {
    const { transfer } = destinationFixture();
    const submit = vi.fn();
    const client = {
      getChainId: vi.fn().mockResolvedValue(transfer.destination.chainId),
      readContract: vi.fn().mockResolvedValue(1n),
      waitForTransactionReceipt: vi.fn(),
    };
    await expect(
      submitAndVerifyDestinationMint({
        client: client as never,
        transfer,
        submit,
      }),
    ).rejects.toThrow(/already received/);
    expect(submit).not.toHaveBeenCalled();
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("uses bounded nonce-indexed chunks and fails over when an RPC rejects eth_getLogs", async () => {
    const { transfer, transaction, receipt } = destinationFixture();
    const rejectedLogs = vi.fn().mockRejectedValue(new Error("range too wide"));
    const fallbackLogs = vi
      .fn()
      .mockResolvedValue([{ transactionHash: DESTINATION_HASH }]);
    const primary = {
      getChainId: vi.fn().mockResolvedValue(transfer.destination.chainId),
      getBlockNumber: vi.fn().mockResolvedValue(300_000n),
      getLogs: rejectedLogs,
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getTransaction: vi.fn().mockResolvedValue(transaction),
      readContract: vi.fn().mockResolvedValue(1n),
    };
    const fallback = {
      getChainId: vi.fn().mockResolvedValue(transfer.destination.chainId),
      getLogs: fallbackLogs,
    };
    const completed = await discoverDestinationCompletion(
      [primary as never, fallback as never],
      transfer,
    );
    expect(completed.destinationTransactionHash).toBe(DESTINATION_HASH);
    expect(rejectedLogs).toHaveBeenCalledTimes(1);
    const query = fallbackLogs.mock.calls[0]?.[0];
    expect(query.args).toEqual({ nonce: LIVE_NONCE });
    expect(query.address).toBe(transfer.destination.messageTransmitterV2);
    expect(query.fromBlock).toBeGreaterThan(0n);
    expect(
      BigInt(query.toBlock) - BigInt(query.fromBlock) + 1n,
    ).toBeLessThanOrEqual(CCTP_DESTINATION_LOG_CHUNK_SIZE);
  });

  it("maps Iris 404 to pending without a backend request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));
    await expect(
      fetchIrisMessages(26, `0x${"41".repeat(32)}`),
    ).resolves.toEqual({ state: "pending", messages: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "iris-api-sandbox.circle.com/v2/messages/26",
    );
    fetchMock.mockRestore();
  });

  it.each([429, 500, 503])(
    "maps Iris %s to a recoverable provider error",
    async (status) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("", { status }));
      await expect(
        fetchIrisMessages(26, `0x${"41".repeat(32)}`),
      ).rejects.toThrow(/temporarily unavailable/);
      fetchMock.mockRestore();
    },
  );

  it("prevents duplicate concurrent wallet actions", async () => {
    let release!: () => void;
    const first = withBridgeSubmissionLock(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await expect(
      withBridgeSubmissionLock(async () => undefined),
    ).rejects.toThrow(/pending/);
    release();
    await first;
  });

  it("decodes the exact bytes32 nonce and finalized V2 fields", () => {
    const decoded = decodeCctpV2Message(
      message({ nonce: LIVE_NONCE, finality: 2000 }),
    );
    expect(decoded.nonce).toBe(LIVE_NONCE);
    expect(decoded.finalityThresholdExecuted).toBe(2000);
    expect(decoded.amount).toBe(10_000_000n);
  });
});
