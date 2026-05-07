import { useCallback, useMemo } from "react";
import type { WizPayState } from "@/lib/types";

import { useWizPayState } from "./useWizPayState";
import { useWizPayContract } from "./useWizPayContract";
import { useWizPayHistory } from "./useWizPayHistory";
import { useBatchPayroll } from "./useBatchPayroll";
import { useResolvedRecipients } from "./useResolvedRecipients";
import { isStableFxMode } from "@/lib/fx-config";

export function useWizPay(): WizPayState {
  // 1. Initialize UI / Local State
  const state = useWizPayState();
  const preparedRecipients = useResolvedRecipients(state.recipients);

  // 1a. Derived Batch values
  const batchAmount = useMemo(
    () =>
      preparedRecipients.reduce((sum, r) => sum + r.amountUnits, 0n),
    [preparedRecipients]
  );
  const validRecipientCount = useMemo(
    () => preparedRecipients.filter((r) => r.validAddress).length,
    [preparedRecipients]
  );

  // 2. Initialize Contract Interactions
  const contract = useWizPayContract({
    state,
    batchAmount,
    preparedRecipients,
  });

  const batchPayroll = useBatchPayroll({
    activeToken: contract.activeToken,
    approveBatchAmount: contract.requestApproval,
    currentAllowance: contract.currentAllowance,
    recipients: state.recipients,
    pendingBatches: state.pendingBatches,
    referenceId: state.referenceId,
    refetchAllowance: contract.refetchAllowance,
    setStatusMessage: state.setStatusMessage,
    setErrorMessage: state.setErrorMessage,
    submitCurrentBatch: contract.handleSubmit,
  });

  // 3. Initialize History
  const history = useWizPayHistory({
    activeToken: contract.activeToken,
    refetchCb: () => {
      contract.refetchAllowance();
      contract.refetchBalance();
      contract.refetchEngineBalances();
    },
  });

  const isBusy =
    batchPayroll.isRunning ||
    state.approvalState === "signing" ||
    state.approvalState === "confirming" ||
    state.submitState === "simulating" ||
    state.submitState === "wallet" ||
    state.submitState === "confirming";

  const smartBatchCount = batchPayroll.task?.totalUnits ?? state.totalBatches;
  const smartBatchButtonText = batchPayroll.isRunning
    ? batchPayroll.progress.label ?? "Sending..."
    : "Send";
  const requiresSmartBatchApproval =
    batchPayroll.totalAmount > 0n &&
    contract.currentAllowance < batchPayroll.totalAmount;
  const estimatedSmartBatchConfirmations =
    smartBatchCount + (requiresSmartBatchApproval ? 1 : 0);
  const smartBatchHelperText = batchPayroll.isSupported
    ? smartBatchCount > 1
      ? `A single payroll run can include ${batchPayroll.totalRecipients} recipients; Arc just caps each on-chain batch at 50 recipients. Click Send once to run ${smartBatchCount} batch${smartBatchCount === 1 ? "" : "es"}. Your active wallet will ask for up to ${estimatedSmartBatchConfirmations} confirmation${estimatedSmartBatchConfirmations === 1 ? "" : "s"}${requiresSmartBatchApproval ? `: 1 approval plus ${smartBatchCount} batch transactions.` : ` for ${smartBatchCount} batch transactions.`}`
      : requiresSmartBatchApproval
        ? `Click Send once to approve ${state.selectedToken} and submit the current payroll batch. Your active wallet will ask for 2 confirmations: 1 approval plus 1 batch transaction.`
        : "Click Send once to submit the current payroll batch. Your active wallet will ask for 1 batch confirmation."
    : null;

  const resetComposer = useCallback(() => {
    batchPayroll.reset();
    state.resetComposer();
  }, [batchPayroll, state]);

  const dismissSuccessModal = useCallback(() => {
    batchPayroll.reset();
    state.dismissSuccessModal();
  }, [batchPayroll, state]);

  const primaryActionText =
    state.submitState === "simulating"
      ? isStableFxMode
        ? "Preparing Circle Trade..."
        : "Preparing Circle Challenge..."
      : state.submitState === "wallet"
        ? isStableFxMode
          ? "Sign Circle Permit..."
          : "Confirm in Circle..."
        : state.submitState === "confirming"
          ? isStableFxMode
            ? "Settling with Circle..."
            : "Waiting for Circle..."
          : state.submitState === "confirmed"
            ? isStableFxMode
              ? "Trades Settled"
              : "Batch Sent"
            : isStableFxMode
              ? "Settle with Circle"
              : "Send";

  const approvalText =
    state.approvalState === "signing"
      ? isStableFxMode
        ? "Approve in Wallet..."
        : "Approve in Circle..."
      : state.approvalState === "confirming"
        ? "Confirming Approval..."
        : state.approvalState === "confirmed" && !contract.needsApproval
          ? isStableFxMode
            ? "Permit2 Approved"
            : "Approval Confirmed"
          : isStableFxMode
            ? `Approve ${state.selectedToken} via Permit2`
            : `Approve ${state.selectedToken} via Circle`;

  // 4. Return unified state matching the previous monolithic footprint
  return {
    ...state,
    preparedRecipients,
    ...contract,
    ...history,
    batchAmount,
    validRecipientCount,
    isBusy,
    resetComposer,
    dismissSuccessModal,
    primaryActionText,
    approvalText,
    smartBatchAvailable: batchPayroll.isSupported,
    smartBatchRunning: batchPayroll.isRunning,
    smartBatchReason: batchPayroll.availabilityReason,
    smartBatchButtonText,
    smartBatchHelperText,
    smartBatchSubmissionHashes: batchPayroll.submissionHashes,
    payrollTaskId: batchPayroll.taskId,
    payrollTask: batchPayroll.task,
    handleSmartBatchSubmit: batchPayroll.execute,
  };
}
