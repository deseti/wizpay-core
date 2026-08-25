import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_TOKENS } from "@/lib/wizpay";
import { assertCircleTransactionMatches, extractSingleCorrelationId, findMatchingCircleTransaction, readSendOperation, writeSendOperation, type AppWalletSendOperation } from "./send-operation";

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
    expect(readSendOperation(storage)).toMatchObject({ challengeId: "challenge-1", stage: "authorization_completed" });
  });
  it("finds exactly one strictly matching Circle transaction", () => {
    expect(findMatchingCircleTransaction(operation, [{ ...transaction, destinationAddress: `0x${"1".repeat(40)}` }, transaction])?.id).toBe("transaction-1");
    expect(() => assertCircleTransactionMatches(operation, { ...transaction, amounts: ["2"] })).toThrow(/amount mismatch/i);
  });
  it("fails closed when duplicate matching transactions exist", () => {
    expect(() => findMatchingCircleTransaction(operation, [transaction, { ...transaction, id: "transaction-2" }])).toThrow(/more than one/i);
  });
});
