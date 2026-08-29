import { describe, expect, it, vi, afterEach } from "vitest";
import { SUPPORTED_TOKENS } from "@/lib/wizpay";
import {
  CircleActionError,
  acquireSendReconciliation,
  archiveAndClearSendOperation,
  assertCircleTransactionMatches,
  beginReconciliation,
  canSafelyUnlockPreChallenge,
  classifySendStatusError,
  extractSingleCorrelationId,
  findMatchingCircleTransaction,
  findMatchingCircleTransactionPaginated,
  isAmbiguousChallengeCreationError,
  isSendOperationLocked,
  readSendOperation,
  sendExecutionState,
  sendOperationStorageKey,
  shouldPollSendOperation,
  writeSendOperation,
  type AppWalletSendOperation,
  type SendOperationScope,
} from "./send-operation";

const scope: SendOperationScope = {
  userId: "user-1",
  walletId: "wallet-1",
  sender: "0x56DE876C902AdA72CF8E7595715127cEA27d43E6",
  chainId: 5042002,
};
const operation: AppWalletSendOperation = {
  version: 3,
  operationId: "SEND-1",
  idempotencyKey: "idem",
  walletMode: "circle",
  authMethod: "google",
  userId: scope.userId,
  walletId: scope.walletId,
  challengeId: "challenge-1",
  chainId: scope.chainId,
  sender: scope.sender,
  token: "USDC",
  tokenAddress: SUPPORTED_TOKENS.USDC.address,
  circleTokenId: "token-1",
  recipient: "0x32F251fc36A1174901124589EAC2d4E391816F69",
  amountUnits: "1000000",
  amountDisplay: "1",
  createdAt: "2026-08-25T08:48:00Z",
  updatedAt: "2026-08-25T08:48:00Z",
  retryCount: 0,
  stage: "authorization_completed",
};
const transaction = {
  id: "transaction-1",
  state: "COMPLETE",
  operation: "TRANSFER",
  blockchain: "ARC-TESTNET",
  walletId: "wallet-1",
  sourceAddress: operation.sender,
  destinationAddress: operation.recipient,
  amounts: ["1"],
  tokenId: "token-1",
  txHash: `0x${"a".repeat(64)}`,
  createDate: "2026-08-25T08:49:00Z",
};
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    } as unknown as Storage,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("App Wallet Send recovery", () => {
  it("does not require a persistent lock for a definitive pre-challenge rejection", () => {
    expect(
      isAmbiguousChallengeCreationError(
        new CircleActionError("invalid destination", 400),
      ),
    ).toBe(false);
    expect(isSendOperationLocked("pre_challenge_failed")).toBe(false);
  });
  it("persists authoritative challenge metadata only after challenge creation", () => {
    const { storage } = memoryStorage();
    writeSendOperation(storage, operation);
    expect(readSendOperation(storage, scope)).toMatchObject({
      challengeId: "challenge-1",
      userId: "user-1",
      retryCount: 0,
    });
  });
  it.each([
    new TypeError("Failed to fetch"),
    new Error("connection reset"),
    new CircleActionError("upstream failed", 500),
    new CircleActionError("timed out", 408),
  ])("keeps ambiguous challenge creation protected for %s", (error) => {
    expect(isAmbiguousChallengeCreationError(error)).toBe(true);
    expect(isSendOperationLocked("status_unknown")).toBe(true);
  });
  it("keeps challenge-only authorization recoverable until correlation arrives", () => {
    expect(
      extractSingleCorrelationId({
        id: "challenge-1",
        status: "COMPLETE",
        correlationIds: [],
      }),
    ).toBeNull();
    expect(
      extractSingleCorrelationId({
        id: "challenge-1",
        status: "COMPLETE",
        correlationIds: ["transaction-1"],
      }),
    ).toBe("transaction-1");
  });
  it("adds bounded reconciliation metadata and unlocks only after proof", () => {
    const stale = {
      ...operation,
      challengeId: undefined,
      stage: "preparing" as const,
    };
    const reconciling = beginReconciliation(
      stale,
      new Date("2026-08-29T00:00:00Z"),
    );
    expect(reconciling).toMatchObject({
      stage: "reconciling",
      retryCount: 1,
      reconciliationOutcome: "pending",
      reconciliationStartedAt: "2026-08-29T00:00:00.000Z",
    });
    expect(canSafelyUnlockPreChallenge(reconciling)).toBe(false);
    expect(
      canSafelyUnlockPreChallenge({
        ...reconciling,
        reconciliationOutcome: "proven_not_created",
      }),
    ).toBe(true);
    expect(
      canSafelyUnlockPreChallenge({
        ...reconciling,
        transactionId: "tx",
        reconciliationOutcome: "proven_not_created",
      }),
    ).toBe(false);
  });
  it("migrates the account-1 stale v3 no-challenge fixture into scoped reconciliation without affecting account 2", () => {
    const { storage, values } = memoryStorage();
    const legacy = {
      ...operation,
      version: 2,
      userId: undefined,
      challengeId: undefined,
      stage: "preparing",
    };
    values.set(
      `wizpay.send.operation.v3:${scope.walletId}:${scope.sender.toLowerCase()}`,
      JSON.stringify(legacy),
    );
    expect(readSendOperation(storage, scope)).toMatchObject({
      userId: "user-1",
      reconciliationOutcome: "pending",
      stage: "preparing",
    });
    expect(
      readSendOperation(storage, {
        ...scope,
        userId: "user-2",
        walletId: "wallet-2",
      }),
    ).toBeNull();
  });
  it("isolates recovery across user, wallet, sender, and chain", () => {
    const { storage, values } = memoryStorage();
    writeSendOperation(storage, operation);
    for (const other of [
      { ...scope, userId: "user-2" },
      { ...scope, walletId: "wallet-2" },
      {
        ...scope,
        sender: "0x1111111111111111111111111111111111111111" as const,
      },
      { ...scope, chainId: 1 },
    ])
      expect(readSendOperation(storage, other)).toBeNull();
    expect(values.has(sendOperationStorageKey(scope))).toBe(true);
  });
  it("allows only one reconciliation owner for the same scoped key", () => {
    const release = acquireSendReconciliation(scope);
    expect(release).not.toBeNull();
    expect(acquireSendReconciliation(scope)).toBeNull();
    const releaseOther = acquireSendReconciliation({ ...scope, userId: "user-2" });
    expect(releaseOther).not.toBeNull();
    releaseOther?.();
    release?.();
    const reacquired = acquireSendReconciliation(scope);
    expect(reacquired).not.toBeNull();
    reacquired?.();
  });
  it("archives a failed Circle transaction and permits a new Send", () => {
    const { storage } = memoryStorage();
    const failed = { ...operation, stage: "terminal_error" as const };
    writeSendOperation(storage, failed);
    archiveAndClearSendOperation(storage, failed);
    expect(readSendOperation(storage, scope)).toBeNull();
    expect(isSendOperationLocked(failed.stage)).toBe(false);
  });
  it("classifies Failed to fetch as unknown provider state", () => {
    expect(classifySendStatusError(new TypeError("Failed to fetch"))).toBe(
      "provider_unavailable",
    );
    expect(classifySendStatusError(new Error("request timed out"))).toBe(
      "timed_out",
    );
    expect(sendExecutionState("provider_unavailable")).toBe("unknown");
    expect(shouldPollSendOperation("terminal_error")).toBe(false);
  });
  it("finds exactly one strictly matching Circle transaction", () => {
    expect(
      findMatchingCircleTransaction(operation, [
        { ...transaction, destinationAddress: `0x${"1".repeat(40)}` },
        transaction,
      ])?.id,
    ).toBe("transaction-1");
    expect(() =>
      assertCircleTransactionMatches(operation, {
        ...transaction,
        amounts: ["2"],
      }),
    ).toThrow(/amount mismatch/i);
  });
  it("uses bounded pagination after exact-ID recovery is unavailable", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...transaction,
      id: `not-${index}`,
      destinationAddress: `0x${"1".repeat(40)}`,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: firstPage }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: [transaction] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      findMatchingCircleTransactionPaginated(operation, "user-token"),
    ).resolves.toMatchObject({ id: "transaction-1" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      action: "listUserTransactions",
      pageAfter: "not-49",
    });
  });
});
