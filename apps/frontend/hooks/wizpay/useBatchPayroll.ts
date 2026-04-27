"use client";

import { useCallback, useMemo, useState } from "react";

import { backendFetch } from "@/lib/backend-api";
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
  referenceId: string;
  totalBatches: number;
}

interface PayrollInitRecipient {
  address: string;
  amount: string;
  targetToken: TokenSymbol;
}

interface PayrollInitBatch {
  index: number;
  referenceId: string;
  recipientCount: number;
  totalAmount: string;
  recipients: PayrollInitRecipient[];
}

interface PayrollInitPlan {
  sourceToken: TokenSymbol;
  referenceId: string;
  approvalAmount: string;
  totals: {
    totalAmount: string;
    totalRecipients: number;
    totalBatches: number;
  };
  batches: PayrollInitBatch[];
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

function toRecipientDraftBatch(batch: PayrollInitBatch): RecipientDraft[] {
  return batch.recipients.map((recipient, recipientIndex) => ({
    id: `backend-${batch.index}-${recipientIndex}`,
    address: recipient.address,
    amount: recipient.amount,
    targetToken: recipient.targetToken,
  }));
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
  referenceId,
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
        setProgress({
          stage: "preparing",
          label: "Preparing...",
          currentBatch: 1,
          totalBatches,
        });
        setStatusMessage("Preparing payroll plan on the backend...");

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

        const plannedBatches = initPlan.batches.map((batch) => ({
          ...batch,
          draftRecipients: toRecipientDraftBatch(batch),
        }));
        const plannedTotalBatches = initPlan.totals.totalBatches;
        const plannedTotalRecipients = initPlan.totals.totalRecipients;
        const totalApprovalAmount = BigInt(initPlan.approvalAmount);
      const nextSubmissionHashes: string[] = [];
        let nextApprovalHash: string | null = null;

      if (totalApprovalAmount > 0n && currentAllowance < totalApprovalAmount) {
        setProgress({
          stage: "preparing",
          label: "Approving...",
          currentBatch: 1,
            totalBatches: plannedTotalBatches,
        });

        setStatusMessage(
            `Confirm the ${activeToken.symbol} approval in your wallet. This covers ${plannedTotalRecipients} recipient${plannedTotalRecipients === 1 ? "" : "s"} across ${plannedTotalBatches} batch${plannedTotalBatches === 1 ? "" : "es"}.`
        );

        const approvalResult = await approveBatchAmount(totalApprovalAmount);

        if (!approvalResult.ok) {
          setProgress({
            stage: "error",
            label: "Approval failed",
            currentBatch: 1,
              totalBatches: plannedTotalBatches,
          });
          return;
        }

        if (approvalResult.hash) {
            nextApprovalHash = approvalResult.hash;
          setApprovalHash(approvalResult.hash);
          setHashes([approvalResult.hash]);
        }

        await refetchAllowance();
      }

        for (let batchIndex = 0; batchIndex < plannedBatches.length; batchIndex += 1) {
          const batch = plannedBatches[batchIndex];

        setProgress({
          stage: "executing",
          label:
              plannedTotalBatches > 1
                ? `Batch ${batchIndex + 1}/${plannedTotalBatches}...`
              : "Sending...",
          currentBatch: batchIndex + 1,
            totalBatches: plannedTotalBatches,
        });

        setStatusMessage(
            plannedTotalBatches > 1
              ? `Confirm payroll batch ${batchIndex + 1} of ${plannedTotalBatches} in your wallet.`
            : "Confirm the payroll batch in your wallet."
        );

          const result = await submitCurrentBatch(
            batch.draftRecipients,
            batch.referenceId
          );

        if (!result.ok) {
          setProgress({
            stage: "error",
            label:
                plannedTotalBatches > 1
                ? `Batch ${batchIndex + 1} failed`
                : "Payroll failed",
            currentBatch: batchIndex + 1,
              totalBatches: plannedTotalBatches,
          });
          return;
        }

        if (result.hash) {
          nextSubmissionHashes.push(result.hash);
        }

        if (batchIndex < plannedBatches.length - 1) {
          loadNextBatch();
        }
      }

      const nextHashes = nextApprovalHash
        ? [nextApprovalHash, ...nextSubmissionHashes]
        : nextSubmissionHashes;
      const latestHash =
        nextSubmissionHashes[nextSubmissionHashes.length - 1] ?? nextApprovalHash;

      setHashes(nextHashes);
      setSubmissionHashes(nextSubmissionHashes);
      setLastHash(latestHash ?? null);

      setProgress({
        stage: "success",
        label: plannedTotalBatches > 1 ? "All batches sent" : "Batch sent",
        currentBatch: plannedTotalBatches,
        totalBatches: plannedTotalBatches,
      });
      setStatusMessage(
        plannedTotalBatches > 1
          ? `All ${plannedTotalBatches} payroll batches were confirmed in the active wallet.`
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
    approveBatchAmount,
    batches,
    currentAllowance,
    currentBatchNumber,
    loadNextBatch,
    referenceId,
    refetchAllowance,
    setErrorMessage,
    setStatusMessage,
    submitCurrentBatch,
    totalBatches,
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
