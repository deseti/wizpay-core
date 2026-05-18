"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";

import { backendFetch } from "@/lib/backend-api";
import { PayrollFxRecoveryError } from "@/lib/payroll-fx-settlement-service";
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
  /** Recoverable FX settlement status for App Wallet cross-currency payroll */
  fxStatus: PayrollFxRecoverableStatus | null;
  execute: () => Promise<void>;
  /** Continue settlement from saved funding context without re-debiting */
  recoverFxSettlement: () => Promise<void>;
  reset: () => void;
}

// ─── Recoverable FX Status ──────────────────────────────────────────

export type PayrollFxStep =
  | "funding_confirmed"
  | "resolving_tx_hash"
  | "waiting_funding_confirmation"
  | "settling_fx"
  | "waiting_payout"
  | "payout_confirmed"
  | "submitting_payroll"
  | "error";

export interface PayrollFxRecoverableStatus {
  currentStep: PayrollFxStep;
  fundingCircleTxId: string | null;
  fundingChallengeId: string | null;
  fundingTxHash: string | null;
  fxSettlementStarted: boolean;
  settlementTxHash: string | null;
  payoutTxHash: string | null;
  finalPayrollTxHash: string | null;
  recoverableError: string | null;
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
  const { walletAddress, walletMode } = useActiveWalletAddress();
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
  const [fxStatus, setFxStatus] = useState<PayrollFxRecoverableStatus | null>(null);

  // Ref-based execution lock to prevent duplicate submissions.
  // This survives re-renders and prevents race conditions from double-clicks.
  const executionLockRef = useRef(false);
  // Track referenceIds that have already been funded to prevent double-debit.
  const fundedReferenceIdsRef = useRef(new Set<string>());

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
    // ── Duplicate execution guard ──────────────────────────────────
    // Prevent double-clicks and re-execution of the same payroll run.
    if (executionLockRef.current) {
      logPayrollRouteDiagnostic(
        "[official-payroll-route] BLOCKED — execution already in progress",
        { referenceId },
      );
      return;
    }

    if (fundedReferenceIdsRef.current.has(referenceId)) {
      setErrorMessage(
        "This payroll run has already been funded. Reset the form or use a new reference ID to start a new run.",
      );
      logPayrollRouteDiagnostic(
        "[official-payroll-route] BLOCKED — referenceId already funded",
        { referenceId },
      );
      return;
    }

    executionLockRef.current = true;
    setIsRunning(true);
    setFxStatus(null);
    setTask(null);
    setTaskId(null);
    setApprovalHash(null);
    setStatusMessage(null);
    setErrorMessage(null);

    // Flag to prevent the finally block from releasing the lock when
    // a PayrollFxRecoveryError occurs (source funds already debited).
    let keepLocked = false;

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

          // Apply a safety buffer to the source amount for App Wallet
          // cross-currency settlement. This ensures the swap produces enough
          // target token to cover all recipients after slippage and on-chain fees.
          // Buffer: 2% (200 bps) — conservative for stablecoin pairs.
          // Only applied to App Wallet mode, NOT External Wallet.
          // Only applied to the source funding amount, NOT to recipient payouts.
          const APP_WALLET_FX_BUFFER_BPS = 200n;
          const isAppWalletMode = walletMode === "circle";
          const crossAmountWithBuffer = isAppWalletMode
            ? (BigInt(crossAmount) * (10000n + APP_WALLET_FX_BUFFER_BPS) / 10000n).toString()
            : crossAmount;

          logPayrollRouteDiagnostic(
            "[official-payroll-route] cross-token group",
            {
              targetToken,
              aggregateSourceAmount: crossAmount,
              aggregateSourceAmountWithBuffer: crossAmountWithBuffer,
              bufferApplied: isAppWalletMode,
              bufferBps: isAppWalletMode ? APP_WALLET_FX_BUFFER_BPS.toString() : "0",
              quotedTargetAmount: quotedTargetAmount.toString(),
              recipientCount: allRecipients.filter(
                (r) => r.targetToken === targetToken,
              ).length,
            },
          );

          setStatusMessage(
            `Swapping ${activeToken.symbol} -> ${targetToken} via official adapter...`,
          );

          // Track FX status for recovery UX
          setFxStatus({
            currentStep: "funding_confirmed",
            fundingCircleTxId: null,
            fundingChallengeId: null,
            fundingTxHash: null,
            fxSettlementStarted: false,
            settlementTxHash: null,
            payoutTxHash: null,
            finalPayrollTxHash: null,
            recoverableError: null,
          });

          // Mark this referenceId as funded BEFORE calling executePreSwap.
          // This prevents double-debit: if the pre-swap succeeds in funding
          // but throws during settlement/payout, the referenceId is already
          // locked and a second Send click cannot create another funding tx.
          fundedReferenceIdsRef.current.add(referenceId);

          let swapResult: PreSwapResult;
          try {
            swapResult = await executePreSwap({
              sourceToken: activeToken.symbol,
              targetToken,
              amount: crossAmountWithBuffer,
            });
          } catch (preSwapError) {
            // If the error is a PayrollFxRecoveryError, funding DID happen —
            // keep the referenceId locked and re-throw for the outer catch.
            if (preSwapError instanceof PayrollFxRecoveryError) {
              throw preSwapError;
            }
            // For other errors (session failure, quote failure, user rejected
            // the popup), funding did NOT happen — unlock the referenceId.
            fundedReferenceIdsRef.current.delete(referenceId);
            throw preSwapError;
          }

          if (swapResult.txHash) {
            setApprovalHash(swapResult.txHash);
            setFxStatus((prev) =>
              prev
                ? { ...prev, currentStep: "payout_confirmed", payoutTxHash: swapResult.txHash }
                : prev,
            );
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

      // ── Pre-execution balance validation for cross-currency batches ──
      // After a pre-swap with buffer, the wallet should have enough target token.
      // This check validates that the effective recipient amounts (derived from
      // the original quote) don't exceed what the buffered swap should produce.
      // The 2% buffer on source amount means actual output > quoted output.
      if (didSwap && crossTargets && crossTargets.length > 0) {
        for (const targetToken of crossTargets) {
          const targetTokenConfig = SUPPORTED_TOKENS[targetToken];
          const totalNeededForTarget = effectiveRecipients
            .filter((r) => r.targetToken === targetToken)
            .reduce(
              (sum, r) => sum + parseAmountToUnits(r.amount, targetTokenConfig.decimals),
              0n,
            );

          const payoutAmounts = getPreSwapPayoutAmounts?.(targetToken);
          const quotedOutput = payoutAmounts
            ? Array.from(payoutAmounts.values()).reduce(
                (sum, amount) => sum + BigInt(amount),
                0n,
              )
            : 0n;

          logPayrollRouteDiagnostic(
            "[official-payroll-route] pre-execution balance validation",
            {
              targetToken,
              totalNeededForTarget: totalNeededForTarget.toString(),
              quotedOutput: quotedOutput.toString(),
              sufficient: true,
              humanNeeded: formatUnits(totalNeededForTarget, targetTokenConfig.decimals),
              humanQuoted: formatUnits(quotedOutput, targetTokenConfig.decimals),
              note: "Buffer applied to source amount — actual balance should exceed quoted output",
            },
          );

          // This should not trigger with the buffer, but guard against
          // cases where the quote itself is wildly insufficient.
          if (quotedOutput > 0n && totalNeededForTarget > quotedOutput * 2n) {
            const humanNeeded = formatUnits(totalNeededForTarget, targetTokenConfig.decimals);
            const humanQuoted = formatUnits(quotedOutput, targetTokenConfig.decimals);

            setErrorMessage(
              `Quote mismatch: need ${humanNeeded} ${targetToken} but quote only provides ${humanQuoted} ${targetToken}. ` +
              `This may indicate a pricing issue. Swap was completed — ${targetToken} is in your wallet.`,
            );
            return;
          }
        }
      }

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

      if (hasFailedUnits) {
        const completedUnits = (finalTask?.units ?? []).filter(
          (u) => u.status === "SUCCESS",
        );
        const failedUnits = (finalTask?.units ?? []).filter(
          (u) => u.status === "FAILED",
        );
        const completedHashes = completedUnits
          .map((u) => u.txHash)
          .filter(Boolean);

        logPayrollRouteDiagnostic(
          "[official-payroll-route] partial execution result",
          {
            totalUnits: finalTask?.totalUnits,
            completedCount: completedUnits.length,
            failedCount: failedUnits.length,
            completedHashes,
            failedIndices: failedUnits.map((u) => u.index),
          },
        );

        if (didSwap && crossTargets && crossTargets.length > 0) {
          const targetTokens = crossTargets.join(", ");
          const completedInfo = completedHashes.length > 0
            ? ` Completed batches: ${completedHashes.length}/${finalTask?.totalUnits ?? "?"}.`
            : "";
          setErrorMessage(
            `Swap completed; ${targetTokens} is in your wallet. ` +
            `Payroll partially executed: ${completedUnits.length} batch(es) succeeded, ` +
            `${failedUnits.length} failed (batch index ${failedUnits.map((u) => u.index + 1).join(", ")}).${completedInfo} ` +
            `Check your ${targetTokens} balance — you may need to top up or retry the remaining batch.`,
          );
        } else {
          setErrorMessage(
            `Payroll partially executed: ${completedUnits.length} batch(es) succeeded, ` +
            `${failedUnits.length} failed. Check the task status for details.`,
          );
        }
      }
    } catch (error) {
      const message = getFriendlyErrorMessage(error);

      // If this is a PayrollFxRecoveryError, set structured recovery state.
      // CRITICAL: Do NOT reset isRunning for recovery errors — the button
      // must stay disabled to prevent duplicate source funding.
      if (error instanceof PayrollFxRecoveryError) {
        keepLocked = true;

        const recoverableMessage =
          `Source funding was confirmed, but payroll settlement did not continue. ` +
          `Do not retry until this run is recovered. ` +
          [
            error.fundingTxHash ? `Funding tx: ${error.fundingTxHash}` : null,
            error.fundingChallengeId ? `Challenge: ${error.fundingChallengeId}` : null,
            error.fundingCircleTxId ? `Circle tx: ${error.fundingCircleTxId}` : null,
            error.settlementTxHash ? `Settlement tx: ${error.settlementTxHash}` : null,
          ].filter(Boolean).join(". ") +
          `. Error: ${message}`;

        setFxStatus({
          currentStep: "error",
          fundingCircleTxId: error.fundingCircleTxId,
          fundingChallengeId: error.fundingChallengeId,
          fundingTxHash: error.fundingTxHash,
          fxSettlementStarted: Boolean(error.settlementTxHash),
          settlementTxHash: error.settlementTxHash,
          payoutTxHash: error.payoutTxHash,
          finalPayrollTxHash: null,
          recoverableError: recoverableMessage,
        });
        setErrorMessage(recoverableMessage);

        logPayrollRouteDiagnostic(
          "[official-payroll-route] RECOVERABLE ERROR — FX settlement interrupted",
          {
            step: error.step,
            fundingTxHash: error.fundingTxHash,
            fundingChallengeId: error.fundingChallengeId,
            settlementTxHash: error.settlementTxHash,
            payoutTxHash: error.payoutTxHash,
            originalError: message,
          },
        );
      } else {
        setErrorMessage(message);
      }
    } finally {
      if (!keepLocked) {
        executionLockRef.current = false;
        setIsRunning(false);
      }
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
    walletMode,
    referenceId,
    refetchAllowance,
    refreshTask,
    setErrorMessage,
    setStatusMessage,
    submitCurrentBatch,
  ]);

  /**
   * Continue the payroll flow after a successful pre-swap (or recovery).
   * This handles payroll init, approval, and batch execution.
   */
  const continuePayrollAfterSwap = useCallback(
    async (crossTargets: TokenSymbol[]) => {
      const allRecipients = batches.flat();
      const getPreSwapPayoutAmountsLocal = getPreSwapPayoutAmounts;

      // Build effective recipients
      const effectiveRecipients = allRecipients.map((recipient) => {
        if (recipient.targetToken === activeToken.symbol) {
          return {
            address: recipient.address,
            amount: recipient.amount,
            targetToken: recipient.targetToken,
          };
        }

        const payoutAmounts = getPreSwapPayoutAmountsLocal?.(recipient.targetToken);
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

      // Call payroll init
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

      // Approve if needed
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

      // Execute task units
      let nextUnit: PayrollTaskUnit | null = initPlan.units[0] ?? null;

      while (nextUnit) {
        const result = await submitCurrentBatch(
          toRecipientDraftBatch(nextUnit),
          typeof nextUnit.payload.referenceId === "string"
            ? nextUnit.payload.referenceId
            : initPlan.referenceId,
        );

        const reportPayload = result.ok
          ? { status: "SUCCESS" as const, txHash: result.hash }
          : {
              status: "FAILED" as const,
              error:
                result.error ??
                "Wallet batch execution did not complete successfully.",
            };

        const reportResult: ReportTaskUnitResponse = await backendFetch<ReportTaskUnitResponse>(
          `/tasks/${initPlan.taskId}/units/${nextUnit.id}/report`,
          {
            method: "POST",
            body: JSON.stringify(reportPayload),
          },
        );

        setTask(reportResult.task);
        nextUnit = reportResult.nextUnit;
      }

      await refreshTask(initPlan.taskId);
    },
    [
      activeToken.symbol,
      activeToken.decimals,
      approveBatchAmount,
      batches,
      currentAllowance,
      getPreSwapPayoutAmounts,
      referenceId,
      refetchAllowance,
      refreshTask,
      submitCurrentBatch,
      walletAddress,
    ],
  );

  /**
   * Recovery continuation: reuse the saved funding context to continue
   * settlement without creating a new funding transaction.
   *
   * This is called when the user clicks the button in "Recovery Required" state.
   * It does NOT call executePreSwap again — it directly calls settlePayrollFx
   * with the already-confirmed funding txHash.
   */
  const recoverFxSettlement = useCallback(async () => {
    if (!fxStatus) {
      setErrorMessage("No recovery context available. Start a new payroll run.");
      return;
    }

    const { fundingTxHash, fundingCircleTxId, fundingChallengeId } = fxStatus;

    logPayrollRouteDiagnostic(
      "[official-payroll-route] RECOVERY — attempting to continue from saved funding context",
      { fundingTxHash, fundingCircleTxId, fundingChallengeId, referenceId },
    );

    // Clear the error state but keep the lock — we're retrying, not starting fresh
    setErrorMessage(null);
    setFxStatus((prev) =>
      prev ? { ...prev, currentStep: "settling_fx", recoverableError: null } : prev,
    );
    setStatusMessage("Recovering: continuing FX settlement...");

    try {
      // If we don't have a funding txHash yet, try to resolve it from the saved Circle tx ID
      let resolvedFundingTxHash = fundingTxHash;

      if (!resolvedFundingTxHash && (fundingCircleTxId || fundingChallengeId)) {
        setStatusMessage("Recovering: resolving funding transaction...");

        const { resolveCircleFundingTxHash } = await import(
          "@/lib/payroll-fx-settlement-service"
        );

        resolvedFundingTxHash = await resolveCircleFundingTxHash({
          circleTransactionId: fundingCircleTxId,
          challengeId: fundingChallengeId,
          walletId: null, // We don't re-list; rely on the saved IDs
          destinationAddress: null,
          timeoutMs: 60000,
          onAttempt: (attempt, strategy) => {
            logPayrollRouteDiagnostic(
              "[official-payroll-route] RECOVERY — polling for funding txHash",
              { attempt, strategy, fundingCircleTxId, fundingChallengeId },
            );
          },
        });

        setFxStatus((prev) =>
          prev ? { ...prev, fundingTxHash: resolvedFundingTxHash } : prev,
        );
      }

      if (!resolvedFundingTxHash) {
        throw new Error(
          "Recovery failed: could not resolve the original funding transaction hash. " +
          "The Circle transaction ID or challenge ID did not produce a txHash.",
        );
      }

      // Detect cross-currency targets to determine which settlement to call
      const crossTargets = detectCrossCurrencyTargets(
        activeToken.symbol,
        batches,
      );

      if (!crossTargets || crossTargets.length === 0) {
        throw new Error(
          "Recovery failed: no cross-currency targets detected in current recipients.",
        );
      }

      if (!walletAddress) {
        throw new Error("Recovery failed: wallet address is not available.");
      }

      const { settlePayrollFx } = await import(
        "@/lib/payroll-fx-settlement-service"
      );

      // Re-call settlePayrollFx with the existing funding txHash
      for (const targetToken of crossTargets) {
        const crossAmount = sumAmountsForToken(
          batches,
          targetToken,
          activeToken.decimals,
        );

        // Apply the same 2% buffer as the original execution
        const APP_WALLET_FX_BUFFER_BPS = 200n;
        const isAppWalletMode = walletMode === "circle";
        const crossAmountWithBuffer = isAppWalletMode
          ? (BigInt(crossAmount) * (10000n + APP_WALLET_FX_BUFFER_BPS) / 10000n).toString()
          : crossAmount;

        setStatusMessage(
          `Recovering: settling ${activeToken.symbol} → ${targetToken}...`,
        );

        logPayrollRouteDiagnostic(
          "[official-payroll-route] RECOVERY — calling settlePayrollFx",
          {
            sourceFundingTxHash: resolvedFundingTxHash,
            sourceToken: activeToken.symbol,
            targetToken,
            sourceAmount: crossAmountWithBuffer,
            referenceId: `PAYROLL-FX-${referenceId}-${targetToken}`,
            walletAddress,
          },
        );

        const result = await settlePayrollFx({
          sourceToken: activeToken.symbol,
          targetToken,
          sourceAmount: crossAmountWithBuffer,
          referenceId: `PAYROLL-FX-${referenceId}-${targetToken}`,
          walletAddress,
          sourceFundingTxHash: resolvedFundingTxHash,
        });

        if (result.status !== "settled" || !result.txHash) {
          throw new Error(
            `Recovery FX settlement failed: status=${result.status}, txHash=${result.txHash ?? "null"}`,
          );
        }

        setFxStatus((prev) =>
          prev
            ? {
                ...prev,
                currentStep: "payout_confirmed",
                settlementTxHash: result.txHash,
                payoutTxHash: result.payoutTxHash ?? result.txHash,
                recoverableError: null,
              }
            : prev,
        );

        setApprovalHash(result.payoutTxHash ?? result.txHash);
      }

      // Settlement recovered — now continue with the normal payroll flow
      setStatusMessage("Recovery complete. Submitting payroll...");

      // Release the lock and re-run execute to continue from the payroll init step
      executionLockRef.current = false;
      setFxStatus(null);
      setIsRunning(false);

      // Trigger the normal execute flow — the fundedReferenceIdsRef still has
      // this referenceId, but execute() checks it BEFORE the pre-swap step.
      // We need to temporarily allow it through for the post-swap continuation.
      // Instead of calling execute() again (which would try to re-fund),
      // we proceed directly with payroll init here.
      await continuePayrollAfterSwap(crossTargets);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      logPayrollRouteDiagnostic(
        "[official-payroll-route] RECOVERY FAILED",
        { error: message, fxStatus },
      );

      setFxStatus((prev) =>
        prev
          ? { ...prev, currentStep: "error", recoverableError: `Recovery failed: ${message}` }
          : prev,
      );
      setErrorMessage(`Recovery failed: ${message}`);
    }
  }, [
    activeToken.symbol,
    activeToken.decimals,
    batches,
    continuePayrollAfterSwap,
    fxStatus,
    referenceId,
    setErrorMessage,
    setStatusMessage,
    walletAddress,
    walletMode,
  ]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setTask(null);
    setTaskId(null);
    setApprovalHash(null);
    setFxStatus(null);
    executionLockRef.current = false;
    // Note: fundedReferenceIdsRef is NOT cleared on reset.
    // This prevents re-funding the same referenceId even after reset.
    // A new referenceId is generated when the user starts a new payroll run.
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
    fxStatus,
    execute,
    recoverFxSettlement,
    reset,
  };
}
