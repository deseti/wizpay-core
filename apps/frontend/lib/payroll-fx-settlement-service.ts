import { resolveBackendBaseUrl, buildBackendUrl, backendFetch } from "@/lib/backend-api";
import { findFirstString } from "@/lib/user-swap-quote-parser";
import { isTransactionHash, type TokenSymbol } from "@/lib/wizpay";

function logFxDiag(label: string, value: unknown) {
  if (process.env.NODE_ENV === "production") return;
  console.info(label, value);
}

/**
 * Custom error thrown during App Wallet FX settlement that carries
 * recovery context (tx IDs, hashes, step) so the UI can display
 * a recoverable error instead of a generic failure.
 */
export class PayrollFxRecoveryError extends Error {
  fundingCircleTxId: string | null;
  fundingChallengeId: string | null;
  fundingTxHash: string | null;
  settlementTxHash: string | null;
  payoutTxHash: string | null;
  step: string;

  constructor(
    message: string,
    context: {
      fundingCircleTxId?: string | null;
      fundingChallengeId?: string | null;
      fundingTxHash?: string | null;
      settlementTxHash?: string | null;
      payoutTxHash?: string | null;
      step: string;
    },
  ) {
    super(message);
    this.name = "PayrollFxRecoveryError";
    this.fundingCircleTxId = context.fundingCircleTxId ?? null;
    this.fundingChallengeId = context.fundingChallengeId ?? null;
    this.fundingTxHash = context.fundingTxHash ?? null;
    this.settlementTxHash = context.settlementTxHash ?? null;
    this.payoutTxHash = context.payoutTxHash ?? null;
    this.step = context.step;
  }
}

export interface PayrollFxSettleRequest {
  sourceToken: TokenSymbol;
  targetToken: TokenSymbol;
  /** Aggregate source amount in base units (e.g. "5000000" for 5 USDC) */
  sourceAmount: string;
  /** Idempotency reference for this settlement */
  referenceId: string;
  /** Wallet address of the sender (informational) */
  walletAddress?: string;
  /** Confirmed App Wallet source-token transfer to the treasury. */
  sourceFundingTxHash: string;
}

export interface PayrollFxSettleResponse {
  sourceToken: string;
  targetToken: string;
  sourceAmount: string;
  targetAmount: string;
  txHash: string | null;
  status: "settled" | "failed";
  payoutTxHash?: string | null;
  payoutAmount?: string;
  sourceFundingTxHash?: string;
  sourceFundingAmount?: string;
  walletAddress?: string;
}

export interface WaitForCircleTransactionHashOptions {
  intervalMs?: number;
  onAttempt?: (attempt: number) => void;
  timeoutMs?: number;
}

/**
 * Execute treasury-mediated FX settlement for App Wallet cross-currency payroll.
 *
 * The backend treasury wallet executes the swap server-side using Circle
 * Stablecoin Kits (same path as standalone /swap App Wallet treasury swap).
 *
 * Returns the swap txHash which is ArcScan-visible.
 */
export async function settlePayrollFx(
  params: PayrollFxSettleRequest,
): Promise<PayrollFxSettleResponse> {
  return backendFetch<PayrollFxSettleResponse>("/tasks/payroll/fx-settle", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

function getCircleTxHash(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate =
      findFirstString(value, [
        "data.txHash",
        "data.transactionHash",
        "data.hash",
        "data.transaction.txHash",
        "data.transaction.transactionHash",
        "data.transaction.hash",
        "data.transactions.0.txHash",
        "data.transactions.0.transactionHash",
        "data.transactions.0.hash",
        "transaction.txHash",
        "transaction.transactionHash",
        "transaction.hash",
        "transactions.0.txHash",
        "transactions.0.transactionHash",
        "transactions.0.hash",
        "txHash",
        "transactionHash",
        "hash",
      ]) ?? null;

    if (candidate && isTransactionHash(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Call /w3s/action without the backendFetch data-envelope requirement.
 * The /w3s/action controller returns raw Circle API payloads (no { data } wrapper).
 */
async function postW3sActionRaw(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = buildBackendUrl("/w3s/action", resolveBackendBaseUrl());
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : `W3S action failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export async function getCircleTransaction(transactionId: string) {
  return postW3sActionRaw({
    action: "getTransaction",
    transactionId,
  });
}

export async function listCircleTransactions(params: {
  walletIds?: string;
  destinationAddress?: string;
  blockchain?: string;
}) {
  return postW3sActionRaw({
    action: "listTransactions",
    ...params,
  });
}

/**
 * Extract a txHash from a Circle transaction list response.
 *
 * Selection is deterministic and logged:
 * - Each candidate is inspected and either accepted or rejected with a reason.
 * - Filters are applied in priority order: refId > destination > amount > runStartTime > state > txHash.
 * - If strict filters find nothing, a relaxed pass (destination + state + txHash only) is attempted.
 */
function extractTxHashFromTransactionList(
  response: Record<string, unknown>,
  filters: {
    destinationAddress: string;
    expectedAmount?: string | null;
    refId?: string | null;
    runStartTime?: string | null;
    sourceToken?: string | null;
  },
  diagnostics: {
    referenceId?: string | null;
    attempt?: number;
  } = {},
): { txHash: string | null; candidates: unknown[] } {
  const { destinationAddress, expectedAmount, refId, runStartTime } = filters;

  // Circle list response shape: { transactions: [...] } or array at top level
  const transactions: unknown[] = Array.isArray(response.transactions)
    ? response.transactions
    : Array.isArray(response)
      ? response
      : [];

  const candidateLog: unknown[] = [];

  // Sort by createDate descending so we prefer the most recent transaction
  const sorted = [...transactions].sort((a, b) => {
    const aDate = a && typeof a === "object" ? (a as Record<string, unknown>).createDate : null;
    const bDate = b && typeof b === "object" ? (b as Record<string, unknown>).createDate : null;
    if (typeof aDate === "string" && typeof bDate === "string") {
      return bDate.localeCompare(aDate);
    }
    return 0;
  });

  // ── Strict pass: apply all filters ──
  for (const tx of sorted) {
    if (!tx || typeof tx !== "object") continue;
    const record = tx as Record<string, unknown>;

    const txId = typeof record.id === "string" ? record.id : null;
    const txDest = typeof record.destinationAddress === "string" ? record.destinationAddress.toLowerCase() : null;
    const state = typeof record.state === "string" ? record.state.toUpperCase() : "";
    const txRefId = typeof record.refId === "string" ? record.refId : null;
    const txCreateDate = typeof record.createDate === "string" ? record.createDate : null;
    const txUpdateDate = typeof record.updateDate === "string" ? record.updateDate : null;
    const amounts = Array.isArray(record.amounts) ? record.amounts : [];
    const txHash = getCircleTxHash(record);
    const tokenId = typeof record.tokenId === "string" ? record.tokenId : null;

    const candidateInfo: Record<string, unknown> = {
      id: txId,
      state,
      txHash: txHash ?? null,
      destinationAddress: txDest,
      amounts,
      refId: txRefId,
      tokenId,
      createDate: txCreateDate,
      updateDate: txUpdateDate,
    };

    let rejectionReason: string | null = null;

    // Filter: destination must match
    if (txDest && txDest !== destinationAddress.toLowerCase()) {
      rejectionReason = `destination mismatch: got ${txDest}, want ${destinationAddress.toLowerCase()}`;
    }

    // Filter: state must be terminal with success
    if (!rejectionReason && state && state !== "COMPLETE" && state !== "CONFIRMED" && state !== "SENT") {
      rejectionReason = `state not terminal-success: ${state}`;
    }

    // Filter: must have a valid EVM txHash
    if (!rejectionReason && !txHash) {
      rejectionReason = "no valid EVM txHash (0x + 64 hex) found";
    }

    // Filter: if refId provided and tx has refId, they must match
    if (!rejectionReason && refId && txRefId && txRefId !== refId) {
      rejectionReason = `refId mismatch: got "${txRefId}", want "${refId}"`;
    }

    // Filter: if runStartTime provided, reject transactions created before run
    if (!rejectionReason && runStartTime && txCreateDate && txCreateDate < runStartTime) {
      rejectionReason = `stale: created ${txCreateDate} before runStartTime ${runStartTime}`;
    }

    // Filter: if expectedAmount provided, verify amount matches
    if (!rejectionReason && expectedAmount) {
      const amountMatches = amounts.some((amt) => {
        if (typeof amt !== "string") return false;
        try {
          return Math.abs(parseFloat(amt) - parseFloat(expectedAmount)) < 0.01;
        } catch {
          return amt === expectedAmount;
        }
      });
      if (!amountMatches) {
        rejectionReason = `amount mismatch: got [${amounts.join(", ")}], want ~${expectedAmount}`;
      }
    }

    candidateLog.push({ ...candidateInfo, rejectionReason: rejectionReason ?? "ACCEPTED" });

    if (!rejectionReason && txHash) {
      // Log all candidates for diagnostics
      console.info("[payroll-fx] extractTxHash STRICT MATCH", {
        selectedTxHash: txHash,
        selectedId: txId,
        attempt: diagnostics.attempt,
        referenceId: diagnostics.referenceId,
        totalCandidates: sorted.length,
        candidateLog,
      });
      return { txHash, candidates: candidateLog };
    }
  }

  // ── Relaxed pass: only require destination + txHash exists ──
  // This handles cases where Circle doesn't return refId/amounts in list response
  for (const tx of sorted) {
    if (!tx || typeof tx !== "object") continue;
    const record = tx as Record<string, unknown>;

    const txDest = typeof record.destinationAddress === "string" ? record.destinationAddress.toLowerCase() : null;
    const state = typeof record.state === "string" ? record.state.toUpperCase() : "";
    const txCreateDate = typeof record.createDate === "string" ? record.createDate : null;
    const txHash = getCircleTxHash(record);

    // Relaxed: destination must match
    if (txDest && txDest !== destinationAddress.toLowerCase()) continue;
    // Relaxed: must be in a success-like state
    if (state && state !== "COMPLETE" && state !== "CONFIRMED" && state !== "SENT") continue;
    // Relaxed: must have txHash
    if (!txHash) continue;
    // Relaxed: must not be stale (if runStartTime provided)
    if (runStartTime && txCreateDate && txCreateDate < runStartTime) continue;

    console.info("[payroll-fx] extractTxHash RELAXED MATCH (strict filters failed)", {
      selectedTxHash: txHash,
      selectedId: typeof record.id === "string" ? record.id : null,
      attempt: diagnostics.attempt,
      referenceId: diagnostics.referenceId,
      totalCandidates: sorted.length,
      candidateLog,
    });
    return { txHash, candidates: candidateLog };
  }

  // No match found
  console.warn("[payroll-fx] extractTxHash NO MATCH", {
    attempt: diagnostics.attempt,
    referenceId: diagnostics.referenceId,
    totalCandidates: sorted.length,
    filters: { destinationAddress, expectedAmount, refId, runStartTime },
    candidateLog,
  });
  return { txHash: null, candidates: candidateLog };
}

export async function waitForCircleTransactionHash(
  transactionId: string,
  {
    intervalMs = 3000,
    onAttempt,
    timeoutMs = 120000,
  }: WaitForCircleTransactionHashOptions = {},
) {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempt += 1;
    onAttempt?.(attempt);

    const transaction = await getCircleTransaction(transactionId);
    const txHash = getCircleTxHash(transaction);

    if (txHash) {
      return txHash;
    }

    if (Date.now() - startedAt + intervalMs > timeoutMs) {
      break;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(
    "Circle transaction did not expose an EVM transaction hash before the timeout window ended.",
  );
}

export interface ResolveCircleFundingTxHashOptions {
  /** Circle transaction ID (if available from SDK result) */
  circleTransactionId?: string | null;
  /** Challenge ID from createTransferChallenge */
  challengeId?: string | null;
  /** Circle wallet ID used for the transfer */
  walletId?: string | null;
  /** Treasury deposit address the transfer was sent to */
  destinationAddress?: string | null;
  /** Expected funding amount (human-readable, e.g. "1.0") for filtering */
  expectedAmount?: string | null;
  /** Circle refId used in createTransferChallenge for deterministic binding */
  refId?: string | null;
  /** ISO timestamp of when this payroll run started — reject transactions created before this */
  runStartTime?: string | null;
  /** Polling interval */
  intervalMs?: number;
  /** Total timeout (default 90s) */
  timeoutMs?: number;
  /** Callback on each poll attempt */
  onAttempt?: (attempt: number, strategy: string) => void;
}

/**
 * Resolve the EVM txHash for a Circle App Wallet funding transfer.
 *
 * Hard timeout: 90 seconds. After that, throws with full diagnostic context
 * so the UI can show Recovery Required with actionable information.
 *
 * Uses multiple strategies in order:
 *   1. getTransaction(circleTransactionId) — if a transaction ID is available
 *   2. listTransactions(walletId) — find the transfer by wallet + destination
 *
 * Every poll attempt logs full diagnostics including all candidates inspected
 * and why each was accepted or rejected.
 */
export async function resolveCircleFundingTxHash({
  circleTransactionId,
  challengeId,
  walletId,
  destinationAddress,
  expectedAmount,
  refId,
  runStartTime,
  intervalMs = 3000,
  timeoutMs = 90000,
  onAttempt,
}: ResolveCircleFundingTxHashOptions): Promise<string> {
  const startedAt = Date.now();
  let attempt = 0;
  let lastCandidates: unknown[] = [];
  let lastGetTxResponse: unknown = null;

  // Build ordered list of lookup IDs to try with getTransaction.
  const lookupIds = [circleTransactionId].filter(
    (id): id is string => Boolean(id),
  );

  const context = {
    lookupIds,
    challengeId,
    walletId,
    destinationAddress,
    expectedAmount,
    refId,
    runStartTime,
    timeoutMs,
  };

  console.info("[payroll-fx] resolveCircleFundingTxHash START", context);

  while (Date.now() - startedAt <= timeoutMs) {
    attempt += 1;
    const elapsedMs = Date.now() - startedAt;

    // ── Strategy 1: getTransaction by Circle transaction ID ──
    for (const lookupId of lookupIds) {
      onAttempt?.(attempt, `getTransaction(${lookupId.slice(0, 8)}...)`);

      try {
        const transaction = await getCircleTransaction(lookupId);
        lastGetTxResponse = transaction;
        const txHash = getCircleTxHash(transaction);

        // Log every attempt for the first 3, then every 5th
        if (attempt <= 3 || attempt % 5 === 0 || txHash) {
          console.info("[payroll-fx] getTransaction poll", {
            attempt,
            elapsedMs,
            lookupId,
            foundTxHash: Boolean(txHash),
            txHash: txHash ?? null,
            state: transaction && typeof transaction === "object"
              ? (transaction as Record<string, unknown>).state ?? (transaction as Record<string, unknown>)["data"]
              : null,
            responseKeys: transaction ? Object.keys(transaction) : [],
          });
        }

        if (txHash) {
          console.info("[payroll-fx] resolveCircleFundingTxHash SUCCESS via getTransaction", {
            txHash,
            lookupId,
            attempt,
            elapsedMs,
            ...context,
          });
          return txHash;
        }
      } catch (err) {
        if (attempt <= 2) {
          console.info("[payroll-fx] getTransaction error (expected during processing)", {
            lookupId,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Strategy 2: listTransactions by wallet + destination ──
    if (walletId && destinationAddress) {
      onAttempt?.(attempt, "listTransactions");

      try {
        const listResponse = await listCircleTransactions({
          walletIds: walletId,
        });

        const { txHash, candidates } = extractTxHashFromTransactionList(
          listResponse,
          {
            destinationAddress,
            expectedAmount,
            refId,
            runStartTime,
          },
          { referenceId: refId, attempt },
        );

        lastCandidates = candidates;

        if (txHash) {
          console.info("[payroll-fx] resolveCircleFundingTxHash SUCCESS via listTransactions", {
            txHash,
            attempt,
            elapsedMs,
            ...context,
          });
          return txHash;
        }
      } catch (err) {
        if (attempt <= 2) {
          console.info("[payroll-fx] listTransactions error", {
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Check if we'd exceed timeout on next iteration
    if (Date.now() - startedAt + intervalMs > timeoutMs) {
      break;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, intervalMs);
    });
  }

  // ── TIMEOUT — build detailed diagnostic error ──
  const elapsedMs = Date.now() - startedAt;

  const timeoutDiag = {
    ...context,
    attempt,
    elapsedMs,
    lastGetTxResponse: lastGetTxResponse
      ? (typeof lastGetTxResponse === "object" ? Object.keys(lastGetTxResponse as object) : lastGetTxResponse)
      : null,
    lastCandidatesCount: lastCandidates.length,
    lastCandidates: lastCandidates.slice(0, 10), // cap at 10 for readability
  };

  console.error("[payroll-fx] resolveCircleFundingTxHash TIMEOUT", timeoutDiag);

  const errorMsg =
    `Funding txHash resolution timed out after ${Math.round(elapsedMs / 1000)}s. ` +
    `challengeId=${challengeId ?? "none"}, ` +
    `circleTransactionId=${circleTransactionId ?? "none"}, ` +
    `refId=${refId ?? "none"}, ` +
    `expectedAmount=${expectedAmount ?? "none"}, ` +
    `candidates inspected: ${lastCandidates.length}. ` +
    `The funding was confirmed but the EVM txHash is not yet available.`;

  throw new Error(errorMsg);
}
