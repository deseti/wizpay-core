"use client";

import { useCallback, useMemo, useState } from "react";

import {
  getFriendlyErrorMessage,
  parseAmountToUnits,
  type RecipientDraft,
  type TokenSymbol,
} from "@/lib/wizpay";
import type { TransactionActionResult } from "@/lib/types";

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
  currentBatchNumber: number;
  recipients: RecipientDraft[];
  pendingBatches: RecipientDraft[][];
  loadNextBatch: () => void;
  refetchAllowance: () => Promise<unknown>;
  setStatusMessage: (message: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  submitCurrentBatch: (
    batchRecipients?: RecipientDraft[],
    batchReferenceId?: string
  ) => Promise<TransactionActionResult>;
  totalBatches: number;
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

function getBatchReferenceId(baseReferenceId: string, batchIndex: number) {
  if (batchIndex === 0) {
    return baseReferenceId;
  }

  const matchedSuffix = baseReferenceId.match(/(.*)-(\d+)$/);

  if (matchedSuffix) {
    return `${matchedSuffix[1]}-${parseInt(matchedSuffix[2], 10) + batchIndex}`;
  }

  return `${baseReferenceId}-${batchIndex + 1}`;
}

// ─── Hook ───────────────────────────────────────────────────────────

/**
 * useBatchPayroll — Orchestrate approval + multi-batch payroll client-side.
 */
export function useBatchPayroll({
  activeToken,
  approveBatchAmount,
  currentAllowance,
  currentBatchNumber,
  loadNextBatch,
  recipients,
  pendingBatches,
  refetchAllowance,
  setErrorMessage,
  setStatusMessage,
  submitCurrentBatch,
  totalBatches,
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
  const [isSuccess, setIsSuccess] = useState(false);
  const [progress, setProgress] = useState<BatchPayrollProgress>({
    stage: "idle",
    label: null,
    currentBatch: 0,
    totalBatches,
  });
  const [approvalHash, setApprovalHash] = useState<string | null>(null);
  const [lastHash, setLastHash] = useState<string | null>(null);
  const [hashes, setHashes] = useState<string[]>([]);
  const [submissionHashes, setSubmissionHashes] = useState<string[]>([]);

  const execute = useCallback(async () => {
    setIsRunning(true);
    setIsSuccess(false);
    setApprovalHash(null);
    setLastHash(null);
    setHashes([]);
    setSubmissionHashes([]);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const nextSubmissionHashes: string[] = [];
      const referenceSeed = `PAY-${Date.now()}`;
      const effectiveReferenceId = referenceSeed;
      const totalApprovalAmount = totals.totalAmount;

      if (totalApprovalAmount > 0n && currentAllowance < totalApprovalAmount) {
        setProgress({
          stage: "preparing",
          label: "Approving...",
          currentBatch: 1,
          totalBatches,
        });

        setStatusMessage(
          `Confirm the ${activeToken.symbol} approval in your wallet. This covers ${totals.totalRecipients} recipient${totals.totalRecipients === 1 ? "" : "s"} across ${totalBatches} batch${totalBatches === 1 ? "" : "es"}.`
        );

        const approvalResult = await approveBatchAmount(totalApprovalAmount);

        if (!approvalResult.ok) {
          setProgress({
            stage: "error",
            label: "Approval failed",
            currentBatch: 1,
            totalBatches,
          });
          return;
        }

        if (approvalResult.hash) {
          setApprovalHash(approvalResult.hash);
          setHashes([approvalResult.hash]);
        }

        await refetchAllowance();
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];
        const batchReferenceId = getBatchReferenceId(
          effectiveReferenceId,
          batchIndex
        );

        setProgress({
          stage: "executing",
          label:
            totalBatches > 1
              ? `Batch ${batchIndex + 1}/${totalBatches}...`
              : "Sending...",
          currentBatch: batchIndex + 1,
          totalBatches,
        });

        setStatusMessage(
          totalBatches > 1
            ? `Confirm payroll batch ${batchIndex + 1} of ${totalBatches} in your wallet.`
            : "Confirm the payroll batch in your wallet."
        );

        const result = await submitCurrentBatch(batch, batchReferenceId);

        if (!result.ok) {
          setProgress({
            stage: "error",
            label:
              totalBatches > 1
                ? `Batch ${batchIndex + 1} failed`
                : "Payroll failed",
            currentBatch: batchIndex + 1,
            totalBatches,
          });
          return;
        }

        if (result.hash) {
          nextSubmissionHashes.push(result.hash);
        }

        if (batchIndex < batches.length - 1) {
          loadNextBatch();
        }
      }

      const nextHashes = approvalHash
        ? [approvalHash, ...nextSubmissionHashes]
        : nextSubmissionHashes;
      const latestHash =
        nextSubmissionHashes[nextSubmissionHashes.length - 1] ?? approvalHash;

      setHashes(nextHashes);
      setSubmissionHashes(nextSubmissionHashes);
      setLastHash(latestHash ?? null);

      setProgress({
        stage: "success",
        label: totalBatches > 1 ? "All batches sent" : "Batch sent",
        currentBatch: totalBatches,
        totalBatches,
      });
      setStatusMessage(
        totalBatches > 1
          ? `All ${totalBatches} payroll batches were confirmed in the active wallet.`
          : "Payroll batch confirmed in the active wallet."
      );
      setIsSuccess(true);
    } catch (error) {
      const message = getFriendlyErrorMessage(error);

      setProgress({
        stage: "error",
        label: "Payroll failed",
        currentBatch: currentBatchNumber,
        totalBatches,
      });

      setErrorMessage(message);
    } finally {
      setIsRunning(false);
    }
  }, [
    activeToken.symbol,
    approvalHash,
    approveBatchAmount,
    batches,
    currentAllowance,
    currentBatchNumber,
    loadNextBatch,
    refetchAllowance,
    setErrorMessage,
    setStatusMessage,
    submitCurrentBatch,
    totalBatches,
    totals.totalAmount,
    totals.totalRecipients,
  ]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setIsSuccess(false);
    setApprovalHash(null);
    setLastHash(null);
    setHashes([]);
    setSubmissionHashes([]);
    setProgress({
      stage: "idle",
      label: null,
      currentBatch: 0,
      totalBatches,
    });
  }, [totalBatches]);

  return {
    ...totals,
    isSupported: true,
    availabilityReason: null,
    isRunning,
    isSuccess,
    progress,
    approvalHash,
    lastHash,
    hashes,
    submissionHashes,
    execute,
    reset,
  };
}
