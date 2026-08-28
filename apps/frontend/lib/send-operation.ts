import { getAddress, isAddress, type Address, type Hex } from "viem";

import { buildBackendUrl, resolveBackendBaseUrl } from "@/lib/backend-api";
import type { TokenSymbol } from "@/lib/wizpay";

export const SEND_OPERATION_STORAGE_PREFIX = "wizpay.send.operation.v3";
export const SEND_OPERATION_HISTORY_PREFIX = "wizpay.send.history.v1";
export const LEGACY_SEND_OPERATION_STORAGE_KEYS = ["wizpay.send.operation.v2", "wizpay.send.operation", "wizpay.send.pending"] as const;

export type SendOperationScope = { walletId: string; sender: Address };

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
  | "terminal_error";

export type AppWalletSendOperation = {
  version: 2;
  operationId: string;
  idempotencyKey: string;
  walletMode: "circle";
  authMethod: "email" | "google";
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
  stage: AppWalletSendStage;
  lastError?: string;
};

type CircleChallenge = { id?: string; status?: string; correlationIds?: unknown[] };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value[key])) return value[key] as Record<string, unknown>;
  if (isRecord(value.data) && isRecord(value.data[key])) return value.data[key] as Record<string, unknown>;
  return null;
}

export function parseCircleChallenge(value: unknown): CircleChallenge | null {
  const record = nestedRecord(value, "challenge") ?? (isRecord(value) ? value : null);
  return record ? (record as CircleChallenge) : null;
}

export function parseCircleTransaction(value: unknown): CircleTransaction | null {
  const record = nestedRecord(value, "transaction") ?? (isRecord(value) ? value : null);
  return record ? (record as CircleTransaction) : null;
}

export function parseCircleTransactions(value: unknown): CircleTransaction[] {
  if (!isRecord(value)) return [];
  const candidates = [value.transactions, isRecord(value.data) ? value.data.transactions : null];
  const list = candidates.find(Array.isArray);
  return Array.isArray(list) ? list.filter(isRecord) as CircleTransaction[] : [];
}

export function extractSingleCorrelationId(challenge: CircleChallenge | null) {
  const ids = challenge?.correlationIds?.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) ?? [];
  if (ids.length > 1) throw new Error("Circle returned multiple transaction correlations for one Send operation.");
  return ids[0] ?? null;
}

export function assertCircleTransactionMatches(operation: AppWalletSendOperation, transaction: CircleTransaction) {
  const amount = Array.isArray(transaction.amounts) && transaction.amounts.length === 1 ? String(transaction.amounts[0]) : "";
  if (transaction.operation !== "TRANSFER") throw new Error("Circle transaction operation mismatch.");
  if (transaction.blockchain !== "ARC-TESTNET") throw new Error("Circle transaction chain mismatch.");
  if (transaction.walletId !== operation.walletId) throw new Error("Circle transaction wallet mismatch.");
  if (!transaction.sourceAddress || getAddress(transaction.sourceAddress) !== operation.sender) throw new Error("Circle transaction sender mismatch.");
  if (!transaction.destinationAddress || getAddress(transaction.destinationAddress) !== operation.recipient) throw new Error("Circle transaction recipient mismatch.");
  if (transaction.tokenId !== operation.circleTokenId) throw new Error("Circle transaction token mismatch.");
  if (amount !== operation.amountDisplay) throw new Error("Circle transaction amount mismatch.");
}

export function findMatchingCircleTransaction(operation: AppWalletSendOperation, transactions: CircleTransaction[]) {
  const matches = transactions.filter((transaction) => {
    try { assertCircleTransactionMatches(operation, transaction); return true; } catch { return false; }
  });
  if (matches.length > 1) throw new Error("More than one Circle transaction matches this Send recovery record.");
  return matches[0] ?? null;
}

function validOperation(value: unknown): AppWalletSendOperation | null {
  if (!isRecord(value) || value.version !== 2 || value.walletMode !== "circle") return null;
  if (!isAddress(String(value.sender ?? "")) || !isAddress(String(value.recipient ?? "")) || !isAddress(String(value.tokenAddress ?? ""))) return null;
  if (value.token !== "USDC" && value.token !== "EURC") return null;
  if (value.authMethod !== "email" && value.authMethod !== "google") return null;
  for (const key of ["operationId", "idempotencyKey", "walletId", "circleTokenId", "amountUnits", "amountDisplay", "createdAt", "stage"]) {
    if (typeof value[key] !== "string" || !value[key]) return null;
  }
  return {
    ...(value as unknown as AppWalletSendOperation),
    sender: getAddress(String(value.sender)), recipient: getAddress(String(value.recipient)), tokenAddress: getAddress(String(value.tokenAddress)),
  };
}

export function sendOperationStorageKey(scope: SendOperationScope) {
  return `${SEND_OPERATION_STORAGE_PREFIX}:${scope.walletId}:${scope.sender.toLowerCase()}`;
}

function operationMatchesScope(operation: AppWalletSendOperation, scope: SendOperationScope) {
  return operation.walletId === scope.walletId && operation.sender === getAddress(scope.sender);
}

export function readSendOperation(storage: Storage | undefined, scope: SendOperationScope | null) {
  if (!storage || !scope) return null;
  const scopedKey = sendOperationStorageKey(scope);
  for (const key of [scopedKey, ...LEGACY_SEND_OPERATION_STORAGE_KEYS]) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const parsed = validOperation(JSON.parse(raw));
      if (!parsed || !operationMatchesScope(parsed, scope)) continue;
      if (key !== scopedKey) {
        storage.setItem(scopedKey, JSON.stringify(parsed));
        storage.removeItem(key);
      }
      return parsed;
    } catch { /* fail closed on malformed legacy data */ }
  }
  return null;
}

export function writeSendOperation(storage: Storage | undefined, operation: AppWalletSendOperation) {
  storage?.setItem(sendOperationStorageKey({ walletId: operation.walletId, sender: operation.sender }), JSON.stringify(operation));
}

export function archiveAndClearSendOperation(storage: Storage | undefined, operation: AppWalletSendOperation) {
  if (!storage) return;
  const scope = { walletId: operation.walletId, sender: operation.sender };
  const historyKey = `${SEND_OPERATION_HISTORY_PREFIX}:${scope.walletId}:${scope.sender.toLowerCase()}`;
  let history: unknown[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(historyKey) ?? "[]");
    if (Array.isArray(parsed)) history = parsed;
  } catch { /* replace malformed history with a valid audit list */ }
  storage.setItem(historyKey, JSON.stringify([...history, operation].slice(-20)));
  storage.removeItem(sendOperationStorageKey(scope));
}

async function readAction(action: string, userToken: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(buildBackendUrl("/w3s/action", resolveBackendBaseUrl()), {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal,
    body: JSON.stringify({ action, ...params, userToken }),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Circle status is temporarily unavailable.");
  return payload;
}

export const getUserChallengeStatus = (challengeId: string, userToken: string, signal?: AbortSignal) =>
  readAction("getUserChallenge", userToken, { challengeId }, signal).then(parseCircleChallenge);
export const getUserTransactionStatus = (transactionId: string, userToken: string, signal?: AbortSignal) =>
  readAction("getUserTransaction", userToken, { transactionId }, signal).then(parseCircleTransaction);
export const listUserTransactionStatus = (walletId: string, userToken: string, signal?: AbortSignal) =>
  readAction("listUserTransactions", userToken, { walletId }, signal).then(parseCircleTransactions);
export const estimateUserTransferFee = (input: {
  amounts: string[];
  destinationAddress: Address;
  tokenId: string;
  walletId: string;
}, userToken: string, signal?: AbortSignal) =>
  readAction("estimateTransferFee", userToken, { ...input, wizpayChain: "ARC-TESTNET" }, signal);

export function isCircleTerminalFailure(state: string | undefined) {
  return ["FAILED", "CANCELLED", "CANCELED", "DENIED", "REJECTED", "EXPIRED"].includes(state?.toUpperCase() ?? "");
}

export function isCircleComplete(state: string | undefined) {
  return ["COMPLETE", "CONFIRMED"].includes(state?.toUpperCase() ?? "");
}

export function classifySendStatusError(error: unknown): Extract<AppWalletSendStage, "provider_unavailable" | "timed_out" | "status_unknown"> {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/timeout|timed out/.test(message)) return "timed_out";
  if (/failed to fetch|network|temporarily unavailable|service unavailable/.test(message)) return "provider_unavailable";
  return "status_unknown";
}

export function isSendOperationLocked(stage: AppWalletSendStage) {
  return stage !== "completed" && stage !== "terminal_error";
}

export function sendExecutionState(stage: AppWalletSendStage) {
  if (stage === "completed") return "success" as const;
  if (stage === "terminal_error") return "failed" as const;
  if (stage === "timed_out") return "timeout" as const;
  if (["provider_unavailable", "status_unknown", "recoverable_error"].includes(stage)) return "unknown" as const;
  return "pending" as const;
}

export function shouldPollSendOperation(stage: AppWalletSendStage) {
  return !["completed", "terminal_error", "awaiting_user_authorization"].includes(stage);
}
