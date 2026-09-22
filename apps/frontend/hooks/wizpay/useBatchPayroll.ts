"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { backendFetch } from "@/lib/backend-api";
import { bindExecutionIntentTransactionHash } from "@/lib/execution-intent";
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

export type BatchPayrollStage =
  | "idle"
  | "preparing"
  | "executing"
  | "success"
  | "error";

export interface PreSwapResult {
  /** The token the wallet holds for the payroll group after routing. */
  settledToken: TokenSymbol;
  /** Payroll or swap transaction hash, when one was produced. */
  txHash: string | null;
  provider?: "mainnet-atomic";
  outputToken?: TokenSymbol;
  verifiedActualOutput?: string;
}

export interface UseBatchPayrollOptions {
  activeToken: {
    symbol: TokenSymbol;
    decimals: number;
  };
  approveBatchAmount: (
    amount: bigint,
    payrollReferenceId?: string,
  ) => Promise<TransactionActionResult>;
  currentAllowance: bigint;
  /**
   * On-chain WizPayPayrollMainnet feeBps (25 on Arc Mainnet). Used to top up
   * the backend fee-exclusive approval hint to fee-inclusive funding so the
   * approval never leaves the submission short by exactly the fee.
   */
  feeBps?: bigint;
  recipients: RecipientDraft[];
  pendingBatches: RecipientDraft[][];
  refetchAllowance: () => Promise<unknown>;
  setStatusMessage: (message: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  submitCurrentBatch: (
    batchRecipients?: RecipientDraft[],
    batchReferenceId?: string,
    execution?: { intentId: string; idempotencyKey: string },
  ) => Promise<TransactionActionResult>;
  referenceId: string;
  officialQuoteRequired?: boolean;
  officialQuoteReady?: boolean;
  officialQuoteError?: string | null;
  /**
   * True when cross-token execution is unavailable on Arc Mainnet.
   * Send stays disabled and no approval or submission may run.
   */
  crossCurrencyExecutionBlocked?: boolean;
  crossCurrencyExecutionBlockedReason?: string | null;
  getRecoveredPayrollBatch?: (referenceId: string) => Promise<string | null>;
  recordPayrollBatchConfirmation?: (
    referenceId: string,
    txHash: string,
  ) => Promise<void>;
  beginPayrollBatchSubmission?: (referenceId: string) => Promise<void>;
  clearPayrollBatchSubmission?: (referenceId: string) => Promise<void>;
}

interface PayrollInitRecipient {
  address: string;
  amount: string;
  targetToken: TokenSymbol;
  targetTokenAddress?: `0x${string}`;
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
    executionIntentId?: string;
    idempotencyKey?: string;
    executionIntentStatus?: string;
  };
}

interface PayrollInitPlan {
  taskId: string;
  executionIntentId: string;
  idempotencyKey: string;
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
  /** Mainnet recovery status. Always null today; kept for return-shape compatibility. */
  fxStatus: PayrollFxRecoverableStatus | null;
  execute: () => Promise<void>;
  /** Fail-closed recovery entry point. Performs no money movement. */
  recoverFxSettlement: () => Promise<void>;
  reset: () => void;
}

// ─── Mainnet recovery status ────────────────────────────────────────
// Kept minimal and Mainnet-only. There is no off-chain funding or FX
// settlement state on the external-wallet Arc Mainnet route.

export type PayrollFxStep = "submitting_payroll" | "error";

export interface PayrollFxRecoverableStatus {
  currentStep: PayrollFxStep;
  recoverableError: string | null;
  failedReferenceIds: string[];
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

export function calculatePayrollRunTotals(
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

/**
 * Fee-inclusive funding for a same-token payroll group.
 * Mirrors WizPayPayrollMainnet: sum(amounts) + sum(amount*feeBps/10_000).
 * Exported for tests.
 */
export function groupFeeInclusiveAmount(
  groupRecipients: readonly { amount: string }[],
  decimals: number,
  feeBps: bigint,
): bigint {
  let total = 0n;
  for (const recipient of groupRecipients) {
    const amountUnits = parseAmountToUnits(recipient.amount, decimals);
    if (amountUnits <= 0n) continue;
    total += amountUnits + (amountUnits * feeBps) / 10_000n;
  }
  return total;
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

export function mergeSuccessfulSubmissionHashes(
  currentHashes: readonly string[],
  units: readonly Pick<BackendTaskUnit, "status" | "txHash">[],
) {
  const hashes: string[] = [];
  const seen = new Set<string>();

  for (const hash of [
    ...currentHashes,
    ...units
      .filter((unit) => unit.status === "SUCCESS")
      .map((unit) => unit.txHash),
  ]) {
    if (!hash) continue;
    const normalized = hash.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    hashes.push(hash);
  }

  return hashes;
}

export function resolvePayrollRunRecipientCount(
  sessionRecipientCount: number,
  currentRunRecipientCount: number,
  lastTaskRecipientCount: number | null,
) {
  if (sessionRecipientCount > 0) return sessionRecipientCount;
  if (currentRunRecipientCount > 0) return currentRunRecipientCount;
  return lastTaskRecipientCount ?? 0;
}

/**
 * Detect unique cross-token target tokens.
 * Returns null when every recipient matches the source token.
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

function logMainnetPayrollRoute(label: string, value: unknown) {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  console.info(label, value);
}

// ─── Hook ───────────────────────────────────────────────────────────

/**
 * useBatchPayroll — Arc Mainnet-only approval + multi-batch payroll.
 *
 * Execution is strictly external self-custodial: the connected wallet signs
 * every approval and payroll batch. Same-token groups submit directly.
 * Cross-token groups submit as homogeneous Mainnet atomic groups through the
 * payroll contract. When the Mainnet route reports unavailable, execution
 * fails closed before any approval, submission, or state persistence.
 */
export function useBatchPayroll({
  activeToken,
  approveBatchAmount,
  currentAllowance,
  feeBps = 0n,
  recipients,
  pendingBatches,
  referenceId,
  refetchAllowance,
  setErrorMessage,
  setStatusMessage,
  submitCurrentBatch,
  officialQuoteRequired = false,
  officialQuoteReady = false,
  officialQuoteError = null,
  crossCurrencyExecutionBlocked = false,
  crossCurrencyExecutionBlockedReason = null,
  getRecoveredPayrollBatch,
  recordPayrollBatchConfirmation,
  beginPayrollBatchSubmission,
  clearPayrollBatchSubmission,
}: UseBatchPayrollOptions): BatchPayrollResult {
  const { walletAddress } = useActiveWalletAddress();
  const batches = useMemo(
    () => normalizeBatches(recipients, pendingBatches),
    [pendingBatches, recipients],
  );
  const totals = useMemo(
    () => calculatePayrollRunTotals(batches, activeToken.decimals),
    [activeToken.decimals, batches],
  );

  const [isRunning, setIsRunning] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<BackendTask | null>(null);
  const [approvalHash, setApprovalHash] = useState<string | null>(null);
  const [submissionHashes, setSubmissionHashes] = useState<string[]>([]);
  const [fxStatus, setFxStatus] = useState<PayrollFxRecoverableStatus | null>(
    null,
  );

  // Ref-based execution lock to prevent duplicate submissions.
  const executionLockRef = useRef(false);

  const refreshTask = useCallback(async (nextTaskId: string) => {
    try {
      const nextTask = await backendFetch<BackendTask>(`/tasks/${nextTaskId}`);
      setTask(nextTask);
      setSubmissionHashes((current) =>
        mergeSuccessfulSubmissionHashes(current, nextTask.units),
      );
      return nextTask;
    } catch {
      return null;
    }
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
    if (executionLockRef.current) {
      logMainnetPayrollRoute(
        "[mainnet-payroll-route] BLOCKED — execution already in progress",
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
    setSubmissionHashes([]);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      if (!walletAddress) {
        setErrorMessage(
          "Connect an external wallet before sending payroll on Arc Mainnet.",
        );
        return;
      }

      if (!referenceId.trim()) {
        setErrorMessage("Reference ID is required before the batch can be submitted.");
        return;
      }

      const crossTargets = detectCrossCurrencyTargets(
        activeToken.symbol,
        batches,
      );
      const allRecipients = batches.flat();

      logMainnetPayrollRoute("[mainnet-payroll-route] multi-recipient grouping", {
        recipientCount: allRecipients.length,
        crossTargets,
        sameTokenCount: allRecipients.filter(
          (recipient) => recipient.targetToken === activeToken.symbol,
        ).length,
      });

      // Fail closed before any quote, approval, task, or submission work.
      if (
        crossTargets &&
        crossTargets.length > 0 &&
        crossCurrencyExecutionBlocked
      ) {
        setErrorMessage(
          crossCurrencyExecutionBlockedReason ??
            "Cross-token payroll is unavailable on Arc Mainnet.",
        );
        return;
      }

      if (crossTargets && crossTargets.length > 0 && officialQuoteRequired) {
        if (!officialQuoteReady) {
          setErrorMessage(
            officialQuoteError ??
              "Official payroll route quote unavailable. Payroll cannot proceed.",
          );
          return;
        }
      }

      if (allRecipients.length === 0) {
        setErrorMessage("Add at least one payroll recipient before sending.");
        return;
      }

      if (
        !getRecoveredPayrollBatch ||
        !recordPayrollBatchConfirmation ||
        !beginPayrollBatchSubmission ||
        !clearPayrollBatchSubmission
      ) {
        throw new Error(
          "External wallet payroll recovery storage is unavailable.",
        );
      }

      // Group by destination token. The Mainnet payroll contract requires one
      // homogeneous destination token per call, so mixed-token payroll submits
      // one group at a time through the same init/report cycle.
      const groupedRecipients = new Map<TokenSymbol, PayrollInitRecipient[]>();
      for (const recipient of allRecipients) {
        const group = groupedRecipients.get(recipient.targetToken) ?? [];
        group.push({
          address: recipient.address,
          amount: recipient.amount,
          targetToken: recipient.targetToken,
        });
        groupedRecipients.set(recipient.targetToken, group);
      }
      const orderedGroups = [...groupedRecipients.entries()].sort(
        ([left], [right]) =>
          left === activeToken.symbol
            ? -1
            : right === activeToken.symbol
              ? 1
              : left.localeCompare(right),
      );
      const failedGroups: string[] = [];

      for (const [groupToken, groupRecipients] of orderedGroups) {
        const groupReferenceId =
          orderedGroups.length === 1
            ? referenceId
            : `${referenceId}-${groupToken}`;
        const initPlan = await backendFetch<PayrollInitPlan>(
          "/tasks/payroll/init",
          {
            method: "POST",
            body: JSON.stringify({
              sourceToken: activeToken.symbol,
              sourceTokenAddress: SUPPORTED_TOKENS[activeToken.symbol].address,
              referenceId: groupReferenceId,
              runReferenceId: referenceId,
              walletAddress,
              recipients: groupRecipients.map((recipient) => ({
                ...recipient,
                targetTokenAddress:
                  SUPPORTED_TOKENS[recipient.targetToken].address,
              })),
            }),
          },
        );

        setTaskId(initPlan.taskId);
        await refreshTask(initPlan.taskId);

        const groupApprovalAmount = BigInt(initPlan.approvalAmount);
        // Top up the backend hint to fee-inclusive funding. The backend now
        // returns fee-inclusive approval, but older tasks or a zero-fee
        // fallback could still be fee-exclusive; the frontend recomputes from
        // its own on-chain feeBps so approval never leaves the submission
        // short by exactly the payroll fee (e.g. 10000 approved but 10025
        // required at 25 bps for 0.01 USDC). Execution-intent protections are
        // preserved: the approval still acquires/prepares/binds an intent.
        const groupFeeInclusiveApproval = groupFeeInclusiveAmount(
          groupRecipients,
          activeToken.decimals,
          feeBps,
        );
        const requiredApproval =
          groupFeeInclusiveApproval > groupApprovalAmount
            ? groupFeeInclusiveApproval
            : groupApprovalAmount;
        if (
          groupToken === activeToken.symbol &&
          requiredApproval > 0n &&
          currentAllowance < requiredApproval
        ) {
          const approvalResult = await approveBatchAmount(
            requiredApproval,
            groupReferenceId,
          );
          if (!approvalResult.ok) {
            // Surface the actual approval failure instead of collapsing into
            // a generic message. The requestApproval hook already sets a
            // friendly message, but ensure the batch runner does not swallow
            // the reason when that hook returns ok:false.
            setErrorMessage(
              approvalResult.error ??
                "Payroll approval did not complete. Check the wallet prompt, Arc Mainnet connection, and allowance, then retry.",
            );
            await refreshTask(initPlan.taskId);
            return;
          }
          if (approvalResult.hash) setApprovalHash(approvalResult.hash);
          await refetchAllowance();
        }

        let nextUnit: PayrollTaskUnit | null = resumablePayrollUnit(initPlan);
        while (nextUnit) {
          const execution = executionContext(nextUnit, initPlan);
          const unitReferenceId =
            typeof nextUnit.payload.referenceId === "string"
              ? nextUnit.payload.referenceId
              : initPlan.referenceId;
          const recoveredHash =
            await getRecoveredPayrollBatch(unitReferenceId);
          if (!recoveredHash) {
            await beginPayrollBatchSubmission(unitReferenceId);
          }
          const result: TransactionActionResult = recoveredHash
            ? { ok: true, hash: recoveredHash }
            : await submitCurrentBatch(
                toRecipientDraftBatch(nextUnit),
                unitReferenceId,
                execution,
              );

          if (result.ok && result.hash) {
            await bindExecutionIntentTransactionHash(
              execution.intentId,
              result.hash,
              execution.idempotencyKey,
            );
          }

          if (!result.ok && !recoveredHash) {
            await clearPayrollBatchSubmission(unitReferenceId);
          }

          if (result.ok && !recoveredHash) {
            if (!result.hash) {
              throw new Error(
                "Confirmed external wallet payroll batch is missing its transaction hash.",
              );
            }
            await recordPayrollBatchConfirmation(
              unitReferenceId,
              result.hash,
            );
          }

          const reportPayload = result.ok
            ? {
                status: "SUCCESS" as const,
                txHash: result.hash,
                executionIntentId: execution.intentId,
              }
            : {
                status: "FAILED" as const,
                error:
                  result.error ??
                  "Wallet batch execution did not complete successfully.",
              };
          const reportResult: ReportTaskUnitResponse =
            await backendFetch<ReportTaskUnitResponse>(
              `/tasks/${initPlan.taskId}/units/${nextUnit.id}/report`,
              {
                method: "POST",
                body: JSON.stringify(reportPayload),
              },
            );
          setTask(reportResult.task);
          setSubmissionHashes((current) =>
            mergeSuccessfulSubmissionHashes(current, reportResult.task.units),
          );
          if (!result.ok) failedGroups.push(unitReferenceId);
          nextUnit = reportResult.nextUnit;
        }

        await refreshTask(initPlan.taskId);
      }

      if (failedGroups.length > 0) {
        setErrorMessage(
          `Payroll failed for ${failedGroups.join(", ")}; retry this run to resume only unconfirmed batches. No confirmed batch was submitted twice.`,
        );
      }
    } catch (error) {
      setErrorMessage(getFriendlyErrorMessage(error));
    } finally {
      executionLockRef.current = false;
      setIsRunning(false);
    }
  }, [
    activeToken.decimals,
    activeToken.symbol,
    approveBatchAmount,
    batches,
    beginPayrollBatchSubmission,
    clearPayrollBatchSubmission,
    currentAllowance,
    crossCurrencyExecutionBlocked,
    crossCurrencyExecutionBlockedReason,
    feeBps,
    getRecoveredPayrollBatch,
    officialQuoteError,
    officialQuoteReady,
    officialQuoteRequired,
    recordPayrollBatchConfirmation,
    referenceId,
    refetchAllowance,
    refreshTask,
    setErrorMessage,
    setStatusMessage,
    submitCurrentBatch,
    walletAddress,
  ]);

  /**
   * Fail-closed recovery entry point kept for return-shape compatibility.
   * The Mainnet external-wallet route resumes unconfirmed batches through
   * receipt-verified recovery storage during execute(); this entry point
   * performs no money movement.
   */
  const recoverFxSettlement = useCallback(async () => {
    setErrorMessage(
      "Payroll recovery requires a receipt-verified batch. No new transaction was submitted; retry with Send to resume only unconfirmed batches.",
    );
  }, [setErrorMessage]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setTask(null);
    setTaskId(null);
    setApprovalHash(null);
    setSubmissionHashes([]);
    setFxStatus(null);
    executionLockRef.current = false;
  }, []);

  return {
    ...totals,
    isSupported:
      (!officialQuoteRequired || officialQuoteReady) &&
      !crossCurrencyExecutionBlocked,
    availabilityReason: crossCurrencyExecutionBlocked
      ? (crossCurrencyExecutionBlockedReason ??
        "Cross-token payroll is unavailable on Arc Mainnet.")
      : officialQuoteRequired && !officialQuoteReady
        ? (officialQuoteError ??
          "Official payroll route quote unavailable. Payroll cannot proceed.")
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

function executionContext(
  unit: PayrollTaskUnit,
  plan: PayrollInitPlan,
): { intentId: string; idempotencyKey: string } {
  const intentId = unit.payload.executionIntentId ?? plan.executionIntentId;
  const idempotencyKey = unit.payload.idempotencyKey ?? plan.idempotencyKey;
  if (!intentId || !idempotencyKey)
    throw new Error("Durable payroll execution intent is unavailable.");
  return { intentId, idempotencyKey };
}

function resumablePayrollUnit(plan: PayrollInitPlan): PayrollTaskUnit | null {
  const firstPending = plan.units.find((unit) => unit.status === "PENDING");
  if (!firstPending) return null;
  const status = firstPending.payload.executionIntentStatus;
  return !status || status === "CREATED" || status === "FAILED_RETRYABLE"
    ? firstPending
    : null;
}
