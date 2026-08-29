import { getAddress, isAddress, type Address, type Hex } from "viem";

import { buildBackendUrl, resolveBackendBaseUrl } from "@/lib/backend-api";
import type { TokenSymbol } from "@/lib/wizpay";

export const SEND_OPERATION_STORAGE_PREFIX = "wizpay.send.operation.v4";
export const SEND_OPERATION_HISTORY_PREFIX = "wizpay.send.history.v2";
export const LEGACY_SEND_OPERATION_STORAGE_KEYS = [
  "wizpay.send.operation.v3",
  "wizpay.send.operation.v2",
  "wizpay.send.operation",
  "wizpay.send.pending",
] as const;
export const SEND_REQUEST_TIMEOUT_MS = 20_000;
export const SEND_RECONCILIATION_WINDOW_MS = 10 * 60_000;
const activeReconciliationKeys = new Set<string>();

export type SendOperationScope = {
  userId: string;
  walletId: string;
  sender: Address;
  chainId: number;
};
export type ReconciliationOutcome =
  | "pending"
  | "challenge_found"
  | "transaction_found"
  | "proven_not_created"
  | "provider_unavailable"
  | "deadline_reached";
export type AppWalletSendStage =
  | "preparing"
  | "challenge_created"
  | "awaiting_user_authorization"
  | "authorization_completed"
  | "resolving_transaction"
  | "transaction_pending"
  | "confirming_onchain"
  | "verifying_transfer"
  | "completed"
  | "status_unknown"
  | "provider_unavailable"
  | "timed_out"
  | "recoverable_error"
  | "pre_challenge_failed"
  | "reconciling"
  | "terminal_error";

export type AppWalletSendOperation = {
  version: 3;
  operationId: string;
  idempotencyKey: string;
  walletMode: "circle";
  authMethod: "email" | "google";
  userId: string;
  walletId: string;
  challengeId?: string;
  transactionId?: string;
  txHash?: Hex;
  chainId: number;
  sender: Address;
  token: TokenSymbol;
  tokenAddress: Address;
  circleTokenId: string;
  recipient: Address;
  amountUnits: string;
  amountDisplay: string;
  createdAt: string;
  updatedAt: string;
  reconciliationStartedAt?: string;
  lastReconciliationAt?: string;
  reconciliationDeadline?: string;
  reconciliationOutcome?: ReconciliationOutcome;
  retryCount: number;
  stage: AppWalletSendStage;
  lastError?: string;
};

type CircleChallenge = {
  id?: string;
  status?: string;
  correlationIds?: unknown[];
};
export type CircleTransaction = {
  id?: string;
  txHash?: string;
  state?: string;
  operation?: string;
  blockchain?: string;
  walletId?: string;
  sourceAddress?: string;
  destinationAddress?: string;
  amounts?: unknown[];
  tokenId?: string;
  createDate?: string;
};

export class CircleActionError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code?: string | number,
  ) {
    super(message);
    this.name = "CircleActionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value[key])) return value[key] as Record<string, unknown>;
  if (isRecord(value.data) && isRecord(value.data[key]))
    return value.data[key] as Record<string, unknown>;
  return null;
}
export function parseCircleChallenge(value: unknown): CircleChallenge | null {
  const record =
    nestedRecord(value, "challenge") ?? (isRecord(value) ? value : null);
  return record ? (record as CircleChallenge) : null;
}
export function parseCircleChallenges(value: unknown): CircleChallenge[] {
  if (!isRecord(value)) return [];
  const list = [
    value.challenges,
    isRecord(value.data) ? value.data.challenges : null,
  ].find(Array.isArray);
  return Array.isArray(list)
    ? (list.filter(isRecord) as CircleChallenge[])
    : [];
}
export function parseCircleTransaction(
  value: unknown,
): CircleTransaction | null {
  const record =
    nestedRecord(value, "transaction") ?? (isRecord(value) ? value : null);
  return record ? (record as CircleTransaction) : null;
}
export function parseCircleTransactions(value: unknown): CircleTransaction[] {
  if (!isRecord(value)) return [];
  const list = [
    value.transactions,
    isRecord(value.data) ? value.data.transactions : null,
  ].find(Array.isArray);
  return Array.isArray(list)
    ? (list.filter(isRecord) as CircleTransaction[])
    : [];
}
export function extractSingleCorrelationId(challenge: CircleChallenge | null) {
  const ids =
    challenge?.correlationIds?.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    ) ?? [];
  if (ids.length > 1)
    throw new Error(
      "Circle returned multiple transaction correlations for one Send operation.",
    );
  return ids[0] ?? null;
}
export function assertCircleTransactionMatches(
  operation: AppWalletSendOperation,
  transaction: CircleTransaction,
) {
  const amount =
    Array.isArray(transaction.amounts) && transaction.amounts.length === 1
      ? String(transaction.amounts[0])
      : "";
  if (transaction.operation !== "TRANSFER")
    throw new Error("Circle transaction operation mismatch.");
  if (transaction.blockchain !== "ARC-TESTNET")
    throw new Error("Circle transaction chain mismatch.");
  if (transaction.walletId !== operation.walletId)
    throw new Error("Circle transaction wallet mismatch.");
  if (
    !transaction.sourceAddress ||
    getAddress(transaction.sourceAddress) !== operation.sender
  )
    throw new Error("Circle transaction sender mismatch.");
  if (
    !transaction.destinationAddress ||
    getAddress(transaction.destinationAddress) !== operation.recipient
  )
    throw new Error("Circle transaction recipient mismatch.");
  if (transaction.tokenId !== operation.circleTokenId)
    throw new Error("Circle transaction token mismatch.");
  if (amount !== operation.amountDisplay)
    throw new Error("Circle transaction amount mismatch.");
  if (
    transaction.createDate &&
    Date.parse(transaction.createDate) <
      Date.parse(operation.createdAt) - 60_000
  )
    throw new Error("Circle transaction predates this Send attempt.");
}
export function findMatchingCircleTransaction(
  operation: AppWalletSendOperation,
  transactions: CircleTransaction[],
) {
  const matches = transactions.filter((transaction) => {
    try {
      assertCircleTransactionMatches(operation, transaction);
      return true;
    } catch {
      return false;
    }
  });
  if (matches.length > 1)
    throw new Error(
      "More than one Circle transaction matches this Send recovery record.",
    );
  return matches[0] ?? null;
}

function migrateOperation(
  value: Record<string, unknown>,
  scope: SendOperationScope,
): AppWalletSendOperation | null {
  if (
    (value.version !== 2 && value.version !== 3) ||
    value.walletMode !== "circle"
  )
    return null;
  if (
    !isAddress(String(value.sender ?? "")) ||
    !isAddress(String(value.recipient ?? "")) ||
    !isAddress(String(value.tokenAddress ?? ""))
  )
    return null;
  if (value.token !== "USDC" && value.token !== "EURC") return null;
  if (value.authMethod !== "email" && value.authMethod !== "google")
    return null;
  for (const key of [
    "operationId",
    "idempotencyKey",
    "walletId",
    "circleTokenId",
    "amountUnits",
    "amountDisplay",
    "createdAt",
    "stage",
  ])
    if (typeof value[key] !== "string" || !value[key]) return null;
  if (
    value.walletId !== scope.walletId ||
    getAddress(String(value.sender)) !== getAddress(scope.sender) ||
    value.chainId !== scope.chainId
  )
    return null;
  if (value.version === 3 && value.userId !== scope.userId) return null;
  const createdAt = String(value.createdAt);
  return {
    ...(value as unknown as Omit<
      AppWalletSendOperation,
      "version" | "userId" | "updatedAt" | "retryCount"
    >),
    version: 3,
    userId: scope.userId,
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
    retryCount: typeof value.retryCount === "number" ? value.retryCount : 0,
    reconciliationOutcome:
      value.version === 2 &&
      value.stage === "preparing" &&
      !value.challengeId &&
      !value.transactionId
        ? "pending"
        : (value.reconciliationOutcome as ReconciliationOutcome | undefined),
    sender: getAddress(String(value.sender)),
    recipient: getAddress(String(value.recipient)),
    tokenAddress: getAddress(String(value.tokenAddress)),
  };
}
export function sendOperationStorageKey(scope: SendOperationScope) {
  return `${SEND_OPERATION_STORAGE_PREFIX}:${encodeURIComponent(scope.userId)}:${scope.walletId}:${scope.sender.toLowerCase()}:${scope.chainId}`;
}

export function acquireSendReconciliation(
  scope: SendOperationScope,
): (() => void) | null {
  const key = sendOperationStorageKey(scope);
  if (activeReconciliationKeys.has(key)) return null;
  activeReconciliationKeys.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeReconciliationKeys.delete(key);
  };
}
export function operationMatchesScope(
  operation: AppWalletSendOperation,
  scope: SendOperationScope,
) {
  return (
    operation.userId === scope.userId &&
    operation.walletId === scope.walletId &&
    operation.sender === getAddress(scope.sender) &&
    operation.chainId === scope.chainId
  );
}
export function readSendOperation(
  storage: Storage | undefined,
  scope: SendOperationScope | null,
) {
  if (!storage || !scope) return null;
  const scopedKey = sendOperationStorageKey(scope);
  const legacyV3Key = `wizpay.send.operation.v3:${scope.walletId}:${scope.sender.toLowerCase()}`;
  for (const key of [
    scopedKey,
    legacyV3Key,
    ...LEGACY_SEND_OPERATION_STORAGE_KEYS,
  ]) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) continue;
      const parsed = migrateOperation(value, scope);
      if (!parsed) continue;
      if (key !== scopedKey) {
        storage.setItem(scopedKey, JSON.stringify(parsed));
        storage.removeItem(key);
      }
      return parsed;
    } catch {
      /* fail closed on malformed or foreign records */
    }
  }
  return null;
}
export function writeSendOperation(
  storage: Storage | undefined,
  operation: AppWalletSendOperation,
) {
  storage?.setItem(
    sendOperationStorageKey(operation),
    JSON.stringify(operation),
  );
}
export function archiveAndClearSendOperation(
  storage: Storage | undefined,
  operation: AppWalletSendOperation,
) {
  if (!storage) return;
  const historyKey = `${SEND_OPERATION_HISTORY_PREFIX}:${encodeURIComponent(operation.userId)}:${operation.walletId}:${operation.sender.toLowerCase()}:${operation.chainId}`;
  let history: unknown[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(historyKey) ?? "[]");
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    /* replace malformed history */
  }
  storage.setItem(
    historyKey,
    JSON.stringify([...history, operation].slice(-20)),
  );
  storage.removeItem(sendOperationStorageKey(operation));
}
export function withSendMetadata(
  operation: AppWalletSendOperation,
  patch: Partial<AppWalletSendOperation>,
  now = new Date(),
) {
  return {
    ...operation,
    ...patch,
    updatedAt: now.toISOString(),
  } as AppWalletSendOperation;
}
export function beginReconciliation(
  operation: AppWalletSendOperation,
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return withSendMetadata(
    operation,
    {
      stage: "reconciling",
      reconciliationStartedAt: operation.reconciliationStartedAt ?? timestamp,
      lastReconciliationAt: timestamp,
      reconciliationDeadline:
        operation.reconciliationDeadline ??
        new Date(now.getTime() + SEND_RECONCILIATION_WINDOW_MS).toISOString(),
      reconciliationOutcome: "pending",
      retryCount: operation.retryCount + 1,
    },
    now,
  );
}
export function isAmbiguousChallengeCreationError(error: unknown) {
  if (error instanceof CircleActionError)
    return (
      error.status === null ||
      error.status === 408 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    );
  if (isRecord(error) && typeof error.status === "number")
    return error.status === 408 || error.status === 429 || error.status >= 500;
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return /failed to fetch|network|timeout|timed out|connection reset|econnreset|aborted connection|load failed/.test(
    message,
  );
}
export function canSafelyUnlockPreChallenge(operation: AppWalletSendOperation) {
  return (
    !operation.challengeId &&
    !operation.transactionId &&
    operation.reconciliationOutcome === "proven_not_created"
  );
}

function combineTimeout(
  signal?: AbortSignal,
  timeoutMs = SEND_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Circle request timed out.", "TimeoutError"),
      ),
    timeoutMs,
  );
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
async function readAction(
  action: string,
  userToken: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const bounded = combineTimeout(signal);
  try {
    const response = await fetch(
      buildBackendUrl("/w3s/action", resolveBackendBaseUrl()),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: bounded.signal,
        body: JSON.stringify({ action, ...params, userToken }),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok)
      throw new CircleActionError(
        typeof payload.error === "string"
          ? payload.error
          : "Circle status is temporarily unavailable.",
        response.status,
        typeof payload.code === "string" || typeof payload.code === "number"
          ? payload.code
          : undefined,
      );
    return payload;
  } catch (error) {
    if (bounded.signal.aborted && !signal?.aborted)
      throw new CircleActionError("Circle request timed out.", null);
    throw error;
  } finally {
    bounded.cleanup();
  }
}
export const getUserChallengeStatus = (
  challengeId: string,
  userToken: string,
  signal?: AbortSignal,
) =>
  readAction("getUserChallenge", userToken, { challengeId }, signal).then(
    parseCircleChallenge,
  );
export const listActiveUserChallenges = (
  userToken: string,
  signal?: AbortSignal,
) =>
  readAction("listUserChallenges", userToken, {}, signal).then(
    parseCircleChallenges,
  );
export const getUserTransactionStatus = (
  transactionId: string,
  userToken: string,
  signal?: AbortSignal,
) =>
  readAction("getUserTransaction", userToken, { transactionId }, signal).then(
    parseCircleTransaction,
  );
export async function listUserTransactionPage(
  walletId: string,
  userToken: string,
  options: { pageAfter?: string; from?: string } = {},
  signal?: AbortSignal,
) {
  const payload = await readAction(
    "listUserTransactions",
    userToken,
    { walletId, ...options },
    signal,
  );
  const transactions = parseCircleTransactions(payload);
  return {
    transactions,
    nextPageAfter:
      transactions.length === 50
        ? (transactions[transactions.length - 1]?.id ?? null)
        : null,
  };
}
export async function findMatchingCircleTransactionPaginated(
  operation: AppWalletSendOperation,
  userToken: string,
  signal?: AbortSignal,
) {
  let pageAfter: string | undefined;
  let match: CircleTransaction | null = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await listUserTransactionPage(
      operation.walletId,
      userToken,
      { pageAfter, from: operation.createdAt },
      signal,
    );
    const next = findMatchingCircleTransaction(operation, result.transactions);
    if (next && match && next.id !== match.id)
      throw new Error(
        "More than one Circle transaction matches this Send recovery record.",
      );
    match = next ?? match;
    if (!result.nextPageAfter) return match;
    pageAfter = result.nextPageAfter;
  }
  throw new Error(
    "Circle transaction reconciliation exceeded the bounded pagination limit.",
  );
}
export const listUserTransactionStatus = async (
  walletId: string,
  userToken: string,
  signal?: AbortSignal,
) =>
  (await listUserTransactionPage(walletId, userToken, {}, signal)).transactions;
export const estimateUserTransferFee = (
  input: {
    amounts: string[];
    destinationAddress: Address;
    tokenId: string;
    walletId: string;
  },
  userToken: string,
  signal?: AbortSignal,
) =>
  readAction(
    "estimateTransferFee",
    userToken,
    { ...input, wizpayChain: "ARC-TESTNET" },
    signal,
  );
export function isCircleTerminalFailure(state: string | undefined) {
  return [
    "FAILED",
    "CANCELLED",
    "CANCELED",
    "DENIED",
    "REJECTED",
    "EXPIRED",
  ].includes(state?.toUpperCase() ?? "");
}
export function isCircleComplete(state: string | undefined) {
  return ["COMPLETE", "CONFIRMED"].includes(state?.toUpperCase() ?? "");
}
export function classifySendStatusError(
  error: unknown,
): Extract<
  AppWalletSendStage,
  "provider_unavailable" | "timed_out" | "status_unknown"
> {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/timeout|timed out/.test(message)) return "timed_out";
  if (
    /failed to fetch|network|temporarily unavailable|service unavailable|connection reset/.test(
      message,
    )
  )
    return "provider_unavailable";
  return "status_unknown";
}
export function isSendOperationLocked(stage: AppWalletSendStage) {
  return !["completed", "terminal_error", "pre_challenge_failed"].includes(
    stage,
  );
}
export function sendExecutionState(stage: AppWalletSendStage) {
  if (stage === "completed") return "success" as const;
  if (["terminal_error", "pre_challenge_failed"].includes(stage))
    return "failed" as const;
  if (stage === "timed_out") return "timeout" as const;
  if (
    ["provider_unavailable", "status_unknown", "recoverable_error"].includes(
      stage,
    )
  )
    return "unknown" as const;
  return "pending" as const;
}
export function shouldPollSendOperation(stage: AppWalletSendStage) {
  return ![
    "completed",
    "terminal_error",
    "pre_challenge_failed",
    "awaiting_user_authorization",
  ].includes(stage);
}
