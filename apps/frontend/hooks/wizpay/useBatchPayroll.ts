"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { backendFetch } from "@/lib/backend-api";
import {
  getFriendlyErrorMessage,
  parseAmountToUnits,
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
    batchReferenceId?: string
  ) => Promise<TransactionActionResult>;
  referenceId: string;
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
  pendingBatches: RecipientDraft[][]
) {
  return [currentRecipients, ...pendingBatches].filter(
    (batch) => batch.length > 0
  );
}

function calculateTotals(
  batches: RecipientDraft[][],
  decimals: number
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
  return task?.status === "executed" || task?.status === "review" || task?.status === "failed";
}

function getTaskProgress(task: BackendTask | null, fallbackTotal: number): BatchPayrollProgress {
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

// ─── Hook ───────────────────────────────────────────────────────────

/**
 * useBatchPayroll — Orchestrate approval + multi-batch payroll client-side.
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
}: UseBatchPayrollOptions): BatchPayrollResult {
  const batches = useMemo(
    () => normalizeBatches(recipients, pendingBatches),
    [pendingBatches, recipients]
  );
  const totals = useMemo(
    () => calculateTotals(batches, activeToken.decimals),
    [activeToken.decimals, batches]
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
      void refreshTask(taskId).catch(() => {
        // Ignore background polling errors; foreground actions surface them.
      });
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [refreshTask, task, taskId]);

  const submissionHashes = useMemo(() => getSubmissionHashes(task), [task]);
  const hashes = useMemo(
    () => (approvalHash ? [approvalHash, ...submissionHashes] : submissionHashes),
    [approvalHash, submissionHashes]
  );
  const lastHash = submissionHashes[submissionHashes.length - 1] ?? approvalHash;
  const progress = useMemo(
    () => getTaskProgress(task, Math.max(1, batches.length)),
    [batches.length, task]
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
        const initPlan = await backendFetch<PayrollInitPlan>(
          "/tasks/payroll/init",
          {
            method: "POST",
            body: JSON.stringify({
              sourceToken: activeToken.symbol,
              referenceId,
              recipients: batches.flat().map((recipient) => ({
                address: recipient.address,
                amount: recipient.amount,
                targetToken: recipient.targetToken,
              })),
            }),
          }
        );

        setTaskId(initPlan.taskId);
        await refreshTask(initPlan.taskId);

        const totalApprovalAmount = BigInt(initPlan.approvalAmount);

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

      let nextUnit: PayrollTaskUnit | null = initPlan.units[0] ?? null;

      while (nextUnit) {
        const result = await submitCurrentBatch(
          toRecipientDraftBatch(nextUnit),
          typeof nextUnit.payload.referenceId === "string"
            ? nextUnit.payload.referenceId
            : initPlan.referenceId
        );

        const reportResult: ReportTaskUnitResponse = await backendFetch<ReportTaskUnitResponse>(
          `/tasks/${initPlan.taskId}/units/${nextUnit.id}/report`,
          {
            method: "POST",
            body: JSON.stringify(
              result.ok
                ? {
                    status: "SUCCESS",
                    txHash: result.hash,
                  }
                : {
                    status: "FAILED",
                    error: "Wallet batch execution did not complete successfully.",
                  }
            ),
          }
        );

        setTask(reportResult.task);
        nextUnit = reportResult.nextUnit;
      }

      await refreshTask(initPlan.taskId);
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
    } finally {
      setIsRunning(false);
    }
  }, [
    activeToken.symbol,
    approveBatchAmount,
    batches,
    currentAllowance,
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
    isSupported: true,
    availabilityReason: null,
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
