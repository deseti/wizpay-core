/**
 * @deprecated — FX service is moving to backend PayrollAgent + CircleService.
 *
 * Unified FX Service
 *
 * Provides a single interface for FX quoting regardless of the active mode.
 * - Legacy mode: Returns null (the hook reads on-chain getBatchEstimatedOutputs)
 * - StableFX mode: Calls the Next.js API route which proxies to Circle API
 *
 * This service runs client-side and calls our own API routes (not Circle directly).
 */

import { isStableFxMode } from "./fx-config";
import { backendFetch } from "./backend-api";
import type { FxQuote, FxTrade } from "./stablefx";

// ─── Types ──────────────────────────────────────────────────────────

export interface FxQuoteParams {
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: string;
  recipientAddress?: string;
}

interface TaskLogEntry {
  step: string;
  message: string;
}

interface BackendTaskResponse {
  id: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  logs: TaskLogEntry[];
}

/**
 * Request an FX quote.
 * - StableFX mode: calls /api/fx/quote → Circle StableFX API
 * - Legacy mode: returns null (caller should use on-chain estimation)
 */
export async function getQuote(
  params: FxQuoteParams
): Promise<FxQuote | null> {
  if (!isStableFxMode) return null;

  return backendFetch<FxQuote>("/tasks/fx/quote", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Execute an FX trade using a previously obtained quote.
 * Only available in StableFX mode.
 *
 * Permit2 execution flow:
 * 1. Frontend receives typedData from the quote response
 * 2. User signs typedData via eth_signTypedData_v4 (Privy or MetaMask)
 * 3. The hex signature is passed here
 * 4. Circle's FxEscrow pulls tokens via Permit2 and settles atomically
 */
export async function executeFxTrade(params: {
  quoteId: string;
  senderAddress: string;
  signature: string;
  referenceId?: string;
}): Promise<FxTrade> {
  if (!isStableFxMode) {
    throw new Error("executeFxTrade is only available in StableFX mode");
  }

  const task = await backendFetch<BackendTaskResponse>("/tasks/fx/execute", {
    method: "POST",
    body: JSON.stringify(params),
  });

  return mapTaskToFxTrade(task, params.senderAddress, params.referenceId);
}

/**
 * Check the settlement status of an in-flight trade.
 * Only available in StableFX mode.
 */
export async function getFxTradeStatus(tradeId: string): Promise<FxTrade> {
  if (!isStableFxMode) {
    throw new Error("getFxTradeStatus is only available in StableFX mode");
  }

  const task = await backendFetch<BackendTaskResponse>(
    `/tasks/${encodeURIComponent(tradeId)}`
  );

  return mapTaskToFxTrade(task);
}

function mapTaskToFxTrade(
  task: BackendTaskResponse,
  fallbackSenderAddress?: string,
  fallbackReferenceId?: string
): FxTrade {
  const execution = readObject(task.result, "execution");
  const trade = readObject(execution, "trade");
  const payload = task.payload ?? {};

  return {
    tradeId: task.id,
    quoteId: readString(trade, "quoteId") || readString(payload, "quoteId") || "",
    status: mapTaskStatus(task.status, readString(trade, "status")),
    sourceCurrency: readString(trade, "sourceCurrency") || "",
    targetCurrency: readString(trade, "targetCurrency") || "",
    sourceAmount: readString(trade, "sourceAmount") || "0",
    targetAmount: readString(trade, "targetAmount") || "0",
    exchangeRate: readString(trade, "exchangeRate") || "0",
    senderAddress:
      readString(payload, "senderAddress") || fallbackSenderAddress || "",
    referenceId:
      readString(payload, "referenceId") || fallbackReferenceId || "",
    createdAt: readString(trade, "createdAt") || new Date().toISOString(),
    settledAt: readString(trade, "settledAt") || null,
  };
}

function mapTaskStatus(
  taskStatus: string,
  tradeStatus: string | null
): FxTrade["status"] {
  if (tradeStatus === "pending" || tradeStatus === "processing" || tradeStatus === "settled" || tradeStatus === "failed") {
    return tradeStatus;
  }

  if (taskStatus === "executed") {
    return "settled";
  }

  if (taskStatus === "failed" || taskStatus === "partial") {
    return "failed";
  }

  if (taskStatus === "assigned") {
    return "pending";
  }

  return "processing";
}

function readObject(
  source: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const value = source[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(
  source: Record<string, unknown> | null,
  key: string
): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const value = source[key];
  return typeof value === "string" ? value : null;
}
