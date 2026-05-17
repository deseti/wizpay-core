"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";

import { backendFetch } from "@/lib/backend-api";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import {
  getFriendlyErrorMessage,
  parseAmountToUnits,
  SUPPORTED_TOKENS,
  type RecipientDraft,
  type TokenSymbol,
} from "@/lib/wizpay";
import type {
  BackendTask,
  BackendTaskUnit,
  TransactionActionResult,
} from "@/lib/types";

// ─── Types ──────────────────────────────────────────────────────────

type BatchPayrollStage =
  | "idle"
  | "preparing"
  | "executing"
  | "success"
  | "error";

export interface PreSwapResult {
  /** The token the wallet now holds after the swap */
  settledToken: TokenSymbol;
  /** Swap transaction hash */
  txHash: string | null;
}

function logPayrollRouteDiagnostic(label: string, value: unknown) {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  console.info(label, value);
}

interface UseBatchPayrollOptions {
  activeToken: {
    symbol: TokenSymbol;
    decimals: number;
  };
  approveBatchAmount: (amount: bigint) => Promise<TransactionActionResult>;
  currentAllowance: bigint;
  recipients: RecipientDraft[];
  pendingBatches: RecipientDraft[][];
  refetchAllowance: () => Promise<unknown>;
  setStatusMessage: (message: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  submitCurrentBatch: (
    batchRecipients?: RecipientDraft[],
    batchReferenceId?: string,
  ) => Promise<TransactionActionResult>;
  referenceId: string;
  /**
   * Optional: execute a pre-swap for cross-currency payroll.
   * Called when recipients have a different targetToken than activeToken.
   * The external wallet signs the official adapter swap.
   * After this resolves, the wallet holds the target token and payroll
   * proceeds as same-token payout.
   */
  executePreSwap?: (params: {
    sourceToken: TokenSymbol;
    targetToken: TokenSymbol;
    /** Aggregate source amount in the same base-unit shape used by /swap */
    amount: string;
  }) => Promise<PreSwapResult>;
  getPreSwapPayoutAmounts?: (
    targetToken: TokenSymbol,
  ) => Map<string, string> | null;
  officialQuoteRequired?: boolean;
  officialQuoteReady?: boolean;
  officialQuoteError?: string | null;
}

interface PayrollInitRecipient {
  address: string;
  amount: string;
  targetToken: TokenSymbol;
}

interface PayrollTaskUnit {
  id: string;
  index: number;
  type: string;
  status: "PENDING" | "SUCCESS" | "FAILED";
  payload: {
    referenceId?: string;
    recipients?: PayrollInitRecipient[];
    sourceToken?: TokenSymbol;
    totalAmount?: string;
    recipientCount?: number;
  };
}

interface PayrollInitPlan {
  taskId: string;
  approvalAmount: string;
  referenceId: string;
  totalUnits: number;
  units: PayrollTaskUnit[];
}

interface ReportTaskUnitResponse {
  task: BackendTask;
  unit: BackendTaskUnit;
  nextUnit: PayrollTaskUnit | null;
}

interface BatchPayrollTotals {
  totalAmount: bigint;
  totalRecipients: number;
  totalDistributed: Record<TokenSymbol, bigint>;
}

interface BatchPayrollProgress {
  stage: BatchPayrollStage;
  label: string | null;
  currentBatch: number;
  totalBatches: number;
}

interface BatchPayrollResult extends BatchPayrollTotals {
  isSupported: boolean;
  availabilityReason: string | null;
  isRunning: boolean;
  isSuccess: boolean;
  progress: BatchPayrollProgress;
  taskId: string | null;
  task: BackendTask | null;
  approvalHash: string | null;
  lastHash: string | null;
  hashes: string[];
  submissionHashes: string[];
  execute: () => Promise<void>;
  reset: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

function normalizeBatches(
  currentRecipients: RecipientDraft[],
  pendingBatches: RecipientDraft[][],
) {
  return [currentRecipients, ...pendingBatches].filter(
    (batch) => batch.length > 0,
  );
}

function calculateTotals(
  batches: RecipientDraft[][],
  decimals: number,
): BatchPayrollTotals {
  const totalDistributed: Record<TokenSymbol, bigint> = {
    USDC: 0n,
    EURC: 0n,
  };
  let totalAmount = 0n;
  let totalRecipients = 0;

  for (const batch of batches) {
    for (const recipient of batch) {
      const amountUnits = parseAmountToUnits(recipient.amount, decimals);
      totalAmount += amountUnits;
      totalRecipients += 1;
      totalDistributed[recipient.targetToken] += amountUnits;
    }
  }

  return { totalAmount, totalRecipients, totalDistributed };
}

function toRecipientDraftBatch(unit: PayrollTaskUnit): RecipientDraft[] {
  return (unit.payload.recipients ?? []).map((recipient, recipientIndex) => ({
    id: `backend-${unit.index}-${recipientIndex}`,
    address: recipient.address,
    amount: recipient.amount,
    targetToken: recipient.targetToken,
  }));
}

function isTaskTerminal(task: BackendTask | null) {
  return (
    task?.status === "executed" ||
    task?.status === "review" ||
    task?.status === "failed"
  );
}

function getTaskProgress(
  task: BackendTask | null,
  fallbackTotal: number,
): BatchPayrollProgress {
  const latestLog = task?.logs[task.logs.length - 1];

  if (!task) {
    return {
      stage: "idle",
      label: null,
      currentBatch: 0,
      totalBatches: fallbackTotal,
    };
  }

  return {
    stage:
      task.status === "executed"
        ? "success"
        : task.status === "review" || task.status === "failed"
          ? "error"
          : task.status === "created" || task.status === "assigned"
            ? "preparing"
            : "executing",
    label: latestLog?.message ?? null,
    currentBatch: task.completedUnits + task.failedUnits,
    totalBatches: task.totalUnits || fallbackTotal,
  };
}

function getSubmissionHashes(task: BackendTask | null) {
  return (task?.units ?? [])
    .map((unit) => unit.txHash)
    .filter((value): value is string => Boolean(value));
}

/**
 * Detect unique cross-currency target tokens.
 * Returns null if all recipients match sourceToken (same-token payroll).
 */
function detectCrossCurrencyTargets(
  sourceToken: TokenSymbol,
  batches: RecipientDraft[][],
): TokenSymbol[] | null {
  const targets = new Set<TokenSymbol>();

  for (const batch of batches) {
    for (const recipient of batch) {
      if (recipient.targetToken !== sourceToken) {
        targets.add(recipient.targetToken);
      }
    }
  }

  return targets.size > 0 ? Array.from(targets) : null;
}

/**
 * Sum amounts for recipients matching a specific targetToken.
 */
function sumAmountsForToken(
  batches: RecipientDraft[][],
  targetToken: TokenSymbol,
  decimals: number,
): string {
  let totalUnits = 0n;

  for (const batch of batches) {
    for (const recipient of batch) {
      if (recipient.targetToken === targetToken) {
        try {
          const parsedUnits = parseAmountToUnits(recipient.amount, decimals);
          if (parsedUnits > 0n) {
            totalUnits += parsedUnits;
          }
        } catch {
          // Draft validation owns invalid amount errors before execution starts.
        }
      }
    }
  }

  return totalUnits.toString();
}

// ─── Hook ───────────────────────────────────────────────────────────

/**
 * useBatchPayroll — Orchestrate approval + multi-batch payroll client-side.
 *
 * For cross-currency payroll (External Wallet):
 *   1. Detects cross-currency recipients
 *   2. Calls executePreSwap() to swap sourceToken -> targetToken via official adapter
 *   3. After swap, submits payroll as same-token (targetToken -> targetToken)
 *   4. No legacy FX route interaction on-chain
 */
export function useBatchPayroll({
  activeToken,
  approveBatchAmount,
  currentAllowance,
  recipients,
  pendingBatches,
  referenceId,
  refetchAllowance,
  setErrorMessage,
  setStatusMessage,
  submitCurrentBatch,
  executePreSwap,
  getPreSwapPayoutAmounts,
  officialQuoteRequired = false,
  officialQuoteReady = false,
  officialQuoteError = null,
}: UseBatchPayrollOptions): BatchPayrollResult {
  const { walletAddress } = useActiveWalletAddress();
  const batches = useMemo(
    () => normalizeBatches(recipients, pendingBatches),
    [pendingBatches, recipients],
  );
  const totals = useMemo(
    () => calculateTotals(batches, activeToken.decimals),
    [activeToken.decimals, batches],
  );

  const [isRunning, setIsRunning] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<BackendTask | null>(null);
  const [approvalHash, setApprovalHash] = useState<string | null>(null);

  const refreshTask = useCallback(async (nextTaskId: string) => {
    const nextTask = await backendFetch<BackendTask>(`/tasks/${nextTaskId}`);
    setTask(nextTask);
    return nextTask;
  }, []);

  useEffect(() => {
    if (!taskId || isTaskTerminal(task)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }

      void refreshTask(taskId).catch(() => {
        // Ignore background polling errors; foreground actions surface them.
      });
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [refreshTask, task, taskId]);

  const submissionHashes = useMemo(() => getSubmissionHashes(task), [task]);
  const hashes = useMemo(
    () =>
      approvalHash ? [approvalHash, ...submissionHashes] : submissionHashes,
    [approvalHash, submissionHashes],
  );
  const lastHash =
    submissionHashes[submissionHashes.length - 1] ?? approvalHash;
  const progress = useMemo(
    () => getTaskProgress(task, Math.max(1, batches.length)),
    [batches.length, task],
  );
  const isSuccess = task?.status === "executed";

  const execute = useCallback(async () => {
    setIsRunning(true);
    setTask(null);
    setTaskId(null);
    setApprovalHash(null);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      // ── Detect cross-currency groups ─────────────────────────────
      const crossTargets = detectCrossCurrencyTargets(
        activeToken.symbol,
        batches,
      );

      const allRecipients = batches.flat();

      logPayrollRouteDiagnostic(
        "[official-payroll-route] multi-recipient grouping",
        {
          recipientCount: allRecipients.length,
          crossTargets,
          sameTokenCount: allRecipients.filter(
            (r) => r.targetToken === activeToken.symbol,
          ).length,
          crossTokenCounts: crossTargets
            ? Object.fromEntries(
                crossTargets.map((t) => [
                  t,
                  allRecipients.filter((r) => r.targetToken === t).length,
                ]),
              )
            : {},
        },
      );

      // Validate cross-currency quote availability for each cross-token group
      if (crossTargets && crossTargets.length > 0 && officialQuoteRequired) {
        if (!officialQuoteReady) {
          setErrorMessage(
            officialQuoteError ??
              "Official payroll route quote unavailable. Payroll cannot proceed.",
          );
          return;
        }
      }

      // ── Build effective recipients (mixed-token aware) ───────────
      // Same-token recipients pass through unchanged.
      // Cross-token recipients get swapped and rewritten.
      let effectiveRecipients: {
        address: string;
        amount: string;
        targetToken: TokenSymbol;
      }[] = [];
      let didSwap = false;

      if (crossTargets && crossTargets.length > 0 && executePreSwap) {
        // Process each cross-currency target group
        for (const targetToken of crossTargets) {
          const crossAmount = sumAmountsForToken(
            batches,
            targetToken,
            activeToken.decimals,
          );
          const payoutAmounts = getPreSwapPayoutAmounts?.(targetToken);

          if (!payoutAmounts) {
            setErrorMessage(
              `Official quote unavailable for ${activeToken.symbol} -> ${targetToken} aggregate amount ${crossAmount}.`,
            );
            return;
          }

          const quotedTargetAmount = Array.from(payoutAmounts.values()).reduce(
            (sum, amount) => sum + BigInt(amount),
            0n,
          );

          if (quotedTargetAmount <= 0n) {
            setErrorMessage(
              `Official quote unavailable for ${activeToken.symbol} -> ${targetToken} aggregate amount ${crossAmount}.`,
            );
            return;
          }

          logPayrollRouteDiagnostic(
            "[official-payroll-route] cross-token group",
            {
              targetToken,
              aggregateSourceAmount: crossAmount,
              quotedTargetAmount: quotedTargetAmount.toString(),
              recipientCount: allRecipients.filter(
                (r) => r.targetToken === targetToken,
              ).length,
            },
          );

          setStatusMessage(
            `Swapping ${activeToken.symbol} -> ${targetToken} via official adapter...`,
          );

          const swapResult = await executePreSwap({
            sourceToken: activeToken.symbol,
            targetToken,
            amount: crossAmount,
          });

          if (swapResult.txHash) {
            setApprovalHash(swapResult.txHash);
          }

          didSwap = true;

          logPayrollRouteDiagnostic(
            "[official-payroll-route] swap completed for group",
            { targetToken, txHash: swapResult.txHash },
          );
        }

        setStatusMessage("Swap confirmed. Submitting payroll...");
        await refetchAllowance();

        // Build effective recipients: same-token unchanged, cross-token rewritten
        effectiveRecipients = allRecipients.map((recipient) => {
          if (recipient.targetToken === activeToken.symbol) {
            // Same-token: pass through unchanged
            return {
              address: recipient.address,
              amount: recipient.amount,
              targetToken: recipient.targetToken,
            };
          }

          // Cross-token: use allocated payout amount from quote
          const payoutAmounts = getPreSwapPayoutAmounts?.(
            recipient.targetToken,
          );
          const payoutAmount = payoutAmounts?.get(recipient.id);

          return {
            address: recipient.address,
            amount: payoutAmount
              ? formatUnits(
                  BigInt(payoutAmount),
                  SUPPORTED_TOKENS[recipient.targetToken].decimals,
                )
              : recipient.amount,
            targetToken: recipient.targetToken,
          };
        });

        logPayrollRouteDiagnostic(
          "[official-payroll-route] rewritten recipients after pre-swap",
          effectiveRecipients.map((recipient) => ({
            address: recipient.address,
            amount: recipient.amount,
            targetToken: recipient.targetToken,
            amountUnits: parseAmountToUnits(
              recipient.amount,
              SUPPORTED_TOKENS[recipient.targetToken].decimals,
            ).toString(),
          })),
        );
      } else if (crossTargets && crossTargets.length > 0 && !executePreSwap) {
        // Cross-currency detected but no pre-swap handler available
        setErrorMessage(
          "Cross-currency payroll requires the External Wallet swap adapter. " +
            "Connect an external wallet to enable cross-currency payroll.",
        );
        return;
      } else {
        // Pure same-token payroll
        effectiveRecipients = allRecipients.map((recipient) => ({
          address: recipient.address,
          amount: recipient.amount,
          targetToken: recipient.targetToken,
        }));
      }

      // ── Call payroll init ──────────────────────────────────────────
      // sourceToken is always the user's selected token (e.g. USDC).
      // The backend sees each recipient's targetToken to know which are
      // same-token (USDC->USDC) vs rewritten cross-token (EURC->EURC).
      const initPlan = await backendFetch<PayrollInitPlan>(
        "/tasks/payroll/init",
        {
          method: "POST",
          body: JSON.stringify({
            sourceToken: activeToken.symbol,
            referenceId,
            walletAddress,
            recipients: effectiveRecipients,
          }),
        },
      );

      setTaskId(initPlan.taskId);
      await refreshTask(initPlan.taskId);

      const totalApprovalAmount = BigInt(initPlan.approvalAmount);

      // Approve the source token (USDC) for same-token payout batches
      if (totalApprovalAmount > 0n && currentAllowance < totalApprovalAmount) {
        const approvalResult = await approveBatchAmount(totalApprovalAmount);

        if (!approvalResult.ok) {
          await refreshTask(initPlan.taskId);
          return;
        }

        if (approvalResult.hash) {
          setApprovalHash(approvalResult.hash);
        }

        await refetchAllowance();
      }

      // ── Execute task units ─────────────────────────────────────────
      let nextUnit: PayrollTaskUnit | null = initPlan.units[0] ?? null;

      while (nextUnit) {
        logPayrollRouteDiagnostic(
          "[official-payroll-route] executing unit",
          {
            unitId: nextUnit.id,
            index: nextUnit.index,
            sourceToken: nextUnit.payload.sourceToken,
            recipientCount: nextUnit.payload.recipientCount,
            totalAmount: nextUnit.payload.totalAmount,
          },
        );

        const result = await submitCurrentBatch(
          toRecipientDraftBatch(nextUnit),
          typeof nextUnit.payload.referenceId === "string"
            ? nextUnit.payload.referenceId
            : initPlan.referenceId,
        );

        logPayrollRouteDiagnostic(
          "[official-payroll-route] submitCurrentBatch result",
          {
            unitId: nextUnit.id,
            ok: result.ok,
            hash: result.hash,
            error: result.error ?? null,
          },
        );

        const reportPayload = result.ok
          ? { status: "SUCCESS" as const, txHash: result.hash }
          : {
              status: "FAILED" as const,
              error:
                result.error ??
                "Wallet batch execution did not complete successfully.",
            };

        logPayrollRouteDiagnostic(
          "[official-payroll-route] reportUnit payload",
          { unitId: nextUnit.id, ...reportPayload },
        );

        const reportResult: ReportTaskUnitResponse =
          await backendFetch<ReportTaskUnitResponse>(
            `/tasks/${initPlan.taskId}/units/${nextUnit.id}/report`,
            {
              method: "POST",
              body: JSON.stringify(reportPayload),
            },
          );

        setTask(reportResult.task);
        nextUnit = reportResult.nextUnit;
      }

      // After all units processed, check if swap succeeded but payout failed.
      // This is a recoverable state: the user's wallet holds the target token.
      const finalTask = await refreshTask(initPlan.taskId);
      const hasFailedUnits = (finalTask?.units ?? []).some(
        (u) => u.status === "FAILED",
      );

      if (hasFailedUnits && didSwap && crossTargets && crossTargets.length > 0) {
        const targetTokens = crossTargets.join(", ");
        setErrorMessage(
          `Swap completed; ${targetTokens} is in your wallet. Payroll payout failed — you can retry or manually transfer.`,
        );
      }
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
    } finally {
      setIsRunning(false);
    }
  }, [
    activeToken.symbol,
    activeToken.decimals,
    approveBatchAmount,
    batches,
    currentAllowance,
    executePreSwap,
    getPreSwapPayoutAmounts,
    officialQuoteError,
    officialQuoteReady,
    officialQuoteRequired,
    walletAddress,
    referenceId,
    refetchAllowance,
    refreshTask,
    setErrorMessage,
    setStatusMessage,
    submitCurrentBatch,
  ]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setTask(null);
    setTaskId(null);
    setApprovalHash(null);
  }, []);

  return {
    ...totals,
    isSupported: !officialQuoteRequired || officialQuoteReady,
    availabilityReason:
      officialQuoteRequired && !officialQuoteReady
        ? officialQuoteError ??
          "Official payroll route quote unavailable. Payroll cannot proceed."
        : null,
    isRunning,
    isSuccess,
    progress,
    taskId,
    task,
    approvalHash,
    lastHash,
    hashes,
    submissionHashes,
    execute,
    reset,
  };
}
