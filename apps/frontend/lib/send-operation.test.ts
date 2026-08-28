import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_TOKENS } from "@/lib/wizpay";
import { archiveAndClearSendOperation, assertCircleTransactionMatches, classifySendStatusError, extractSingleCorrelationId, findMatchingCircleTransaction, isSendOperationLocked, readSendOperation, sendExecutionState, sendOperationStorageKey, shouldPollSendOperation, writeSendOperation, type AppWalletSendOperation } from "./send-operation";

const operation: AppWalletSendOperation = {
  version: 2, operationId: "SEND-1", idempotencyKey: "idem", walletMode: "circle", authMethod: "google",
  walletId: "wallet-1", challengeId: "challenge-1", chainId: 5042002,
  sender: "0x56DE876C902AdA72CF8E7595715127cEA27d43E6", token: "USDC", tokenAddress: SUPPORTED_TOKENS.USDC.address,
  circleTokenId: "token-1", recipient: "0x32F251fc36A1174901124589EAC2d4E391816F69",
  amountUnits: "1000000", amountDisplay: "1", createdAt: "2026-08-25T08:48:00Z", stage: "authorization_completed",
};
const transaction = { id: "transaction-1", state: "COMPLETE", operation: "TRANSFER", blockchain: "ARC-TESTNET", walletId: "wallet-1", sourceAddress: operation.sender, destinationAddress: operation.recipient, amounts: ["1"], tokenId: "token-1", txHash: `0x${"a".repeat(64)}` };

describe("App Wallet Send recovery", () => {
  it("keeps challenge-only authorization recoverable until correlation arrives", () => {
    expect(extractSingleCorrelationId({ id: "challenge-1", status: "COMPLETE", correlationIds: [] })).toBeNull();
    expect(extractSingleCorrelationId({ id: "challenge-1", status: "COMPLETE", correlationIds: ["transaction-1"] })).toBe("transaction-1");
    expect("challenge-1").not.toBe("transaction-1");
  });
  it("persists and restores unresolved identity without secrets", () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } as unknown as Storage;
    writeSendOperation(storage, operation);
    const serialized = (storage.setItem as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serialized).not.toContain("userToken");
    (storage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(serialized);
    expect(readSendOperation(storage, { walletId: operation.walletId, sender: operation.sender })).toMatchObject({ challengeId: "challenge-1", stage: "authorization_completed" });
  });
  it("isolates recovery by Circle wallet and sender", () => {
    const values = new Map<string, string>();
    const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => values.set(key, value)), removeItem: vi.fn((key: string) => values.delete(key)) } as unknown as Storage;
    writeSendOperation(storage, operation);
    expect(readSendOperation(storage, { walletId: "wallet-2", sender: operation.sender })).toBeNull();
    expect(readSendOperation(storage, { walletId: operation.walletId, sender: "0x1111111111111111111111111111111111111111" })).toBeNull();
    expect(values.has(sendOperationStorageKey({ walletId: operation.walletId, sender: operation.sender }))).toBe(true);
  });
  it("archives a terminal failure before clearing only its scoped active lock", () => {
    const values = new Map<string, string>();
    const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => values.set(key, value)), removeItem: vi.fn((key: string) => values.delete(key)) } as unknown as Storage;
    const failed = { ...operation, stage: "terminal_error" as const };
    writeSendOperation(storage, failed);
    archiveAndClearSendOperation(storage, failed);
    expect(readSendOperation(storage, { walletId: operation.walletId, sender: operation.sender })).toBeNull();
    expect([...values.values()].some((value) => value.includes("terminal_error"))).toBe(true);
  });
  it("keeps provider failures unresolved and closes only terminal states", () => {
    expect(classifySendStatusError(new TypeError("Failed to fetch"))).toBe("provider_unavailable");
    expect(classifySendStatusError(new Error("request timed out"))).toBe("timed_out");
    expect(isSendOperationLocked("provider_unavailable")).toBe(true);
    expect(isSendOperationLocked("terminal_error")).toBe(false);
    expect(isSendOperationLocked("completed")).toBe(false);
  });
  it("renders terminal, pending, unknown, and success as mutually exclusive states", () => {
    expect(sendExecutionState("terminal_error")).toBe("failed");
    expect(sendExecutionState("transaction_pending")).toBe("pending");
    expect(sendExecutionState("provider_unavailable")).toBe("unknown");
    expect(sendExecutionState("completed")).toBe("success");
    expect(shouldPollSendOperation("terminal_error")).toBe(false);
    expect(shouldPollSendOperation("completed")).toBe(false);
    expect(shouldPollSendOperation("transaction_pending")).toBe(true);
  });
  it("finds exactly one strictly matching Circle transaction", () => {
    expect(findMatchingCircleTransaction(operation, [{ ...transaction, destinationAddress: `0x${"1".repeat(40)}` }, transaction])?.id).toBe("transaction-1");
    expect(() => assertCircleTransactionMatches(operation, { ...transaction, amounts: ["2"] })).toThrow(/amount mismatch/i);
  });
  it("fails closed when duplicate matching transactions exist", () => {
    expect(() => findMatchingCircleTransaction(operation, [transaction, { ...transaction, id: "transaction-2" }])).toThrow(/more than one/i);
  });
});
