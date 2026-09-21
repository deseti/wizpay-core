import { useCallback, useEffect, useMemo } from "react";
import { usePublicClient } from "wagmi";
import type { Hex } from "viem";

import type { QuoteSummary, WizPayState } from "@/lib/types";
import { useWizPayState } from "./useWizPayState";
import { useWizPayContract } from "./useWizPayContract";
import { useWizPayHistory } from "./useWizPayHistory";
import { useBatchPayroll } from "./useBatchPayroll";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useCapability } from "@/components/providers/CapabilityProvider";
import { resolvePayrollRoutePolicy } from "@/lib/payroll-route-policy";
import {
  ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE,
  useMainnetUniswapV4Gate,
} from "@/lib/mainnet-uniswap-v4";
import { activeArcChain } from "@/lib/wagmi";
import {
  isTransactionHash,
  SUPPORTED_TOKENS,
  type TokenSymbol,
} from "@/lib/wizpay";

const OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE =
  "Official payroll route quote unavailable. Payroll cannot proceed.";

/**
 * Local recovery ledger for external-wallet batch submission on Arc Mainnet.
 *
 * A confirmed transaction hash is persisted only after its receipt is verified
 * as successful on-chain. Recovery never resumes from an unverified hash; it
 * fails closed so an unconfirmed batch cannot be reported as settled and a
 * confirmed batch cannot be submitted twice.
 */
const MAINNET_PAYROLL_BATCH_STORAGE_PREFIX =
  "wizpay.mainnet.payroll.batch.v1:";

type StoredMainnetPayrollBatch = {
  status: "submitted" | "confirmed";
  txHash: string | null;
  updatedAt: string;
};

function mainnetPayrollBatchKey(referenceId: string) {
  return `${MAINNET_PAYROLL_BATCH_STORAGE_PREFIX}${referenceId}`;
}

function readStoredMainnetPayrollBatch(
  referenceId: string,
): StoredMainnetPayrollBatch | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(
      mainnetPayrollBatchKey(referenceId),
    );
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredMainnetPayrollBatch>;
    if (parsed.status !== "submitted" && parsed.status !== "confirmed") {
      return null;
    }
    if (parsed.txHash !== null && typeof parsed.txHash !== "string") {
      return null;
    }

    return {
      status: parsed.status,
      txHash: parsed.txHash ?? null,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeStoredMainnetPayrollBatch(
  referenceId: string,
  value: StoredMainnetPayrollBatch,
) {
  if (typeof window === "undefined") {
    throw new Error("Payroll recovery storage is unavailable.");
  }

  window.localStorage.setItem(
    mainnetPayrollBatchKey(referenceId),
    JSON.stringify(value),
  );
}

function removeStoredMainnetPayrollBatch(referenceId: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(mainnetPayrollBatchKey(referenceId));
}

function logMainnetPayrollRoute(label: string, value: unknown) {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  console.info(label, value);
}

/**
 * useWizPay — Arc Mainnet-only payroll composer.
 *
 * Execution is strictly external self-custodial: the connected wallet (Reown
 * AppKit, Wagmi, Viem; EOA or Safe) signs every approval and payroll batch.
 * Same-token payroll submits directly. Cross-token payroll resolves through
 * the Mainnet atomic payroll route and stays fail-closed with a clear message
 * until the Mainnet pool reports available and executable.
 */
export function useWizPay(): WizPayState {
  const crossTokenCapability = useCapability("crossTokenPayroll");

  // 1. Composer state (recipient drafts, reference id, messaging).
  const state = useWizPayState();
  const preparedRecipients = state.preparedRecipients;

  // 1a. Derived batch values.
  const batchAmount = useMemo(
    () => preparedRecipients.reduce((sum, r) => sum + r.amountUnits, 0n),
    [preparedRecipients],
  );
  const validRecipientCount = useMemo(
    () => preparedRecipients.filter((r) => r.validAddress).length,
    [preparedRecipients],
  );

  // 2. Contract reads and user-signed execution.
  const contract = useWizPayContract({
    state,
    batchAmount,
    preparedRecipients,
  });

  // 2a. External self-custodial wallet identity. This is the only wallet
  // source: every signature comes from the connected external wallet.
  const { walletAddress } = useActiveWalletAddress();
  const publicClient = usePublicClient({ chainId: activeArcChain.id });

  // 2b. Resolve the Arc Mainnet payroll route before any quote, approval, or
  // submission work. Same-token payroll is direct; cross-token payroll takes
  // the external-wallet Mainnet atomic route when enabled.
  const payrollRoutePolicy = useMemo(
    () =>
      resolvePayrollRoutePolicy({
        network: "arc-mainnet",
        sourceTokenAddress: contract.activeToken.address,
        targetTokenAddresses: [state.recipients, ...state.pendingBatches]
          .flat()
          .filter((recipient) => recipient.amount.trim())
          .map((recipient) => SUPPORTED_TOKENS[recipient.targetToken].address),
        crossTokenEnabled: crossTokenCapability.enabled,
      }),
    [
      contract.activeToken.address,
      crossTokenCapability.enabled,
      state.pendingBatches,
      state.recipients,
    ],
  );

  // 2c. Mainnet pool gate. The atomic cross-token route may only run while
  // the Mainnet pool reports available and executable. Otherwise execution
  // stays fail-closed with the gate message. No synthetic pricing or
  // alternate route is substituted.
  const mainnetSwapGate = useMainnetUniswapV4Gate();
  const atomicRouteBlocked =
    payrollRoutePolicy.kind === "external-wallet-mainnet-atomic" &&
    (!mainnetSwapGate.available || !mainnetSwapGate.executable);
  const crossCurrencyExecutionBlocked =
    payrollRoutePolicy.kind === "cross-token-disabled" || atomicRouteBlocked;
  const crossCurrencyExecutionBlockedReason =
    payrollRoutePolicy.kind === "cross-token-disabled"
      ? payrollRoutePolicy.blockedReason
      : atomicRouteBlocked
        ? (mainnetSwapGate.message ??
          ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE)
        : null;

  // Cross-token funding is quoted live at submit time (handleSubmit via
  // the payroll-quote endpoint), so a required official quote is ready
  // exactly when the shared live swap gate is open. Direct payroll needs no
  // quote and is trivially ready.
  const officialQuoteRequired = payrollRoutePolicy.requiresQuote;
  // Cross-token funding comes from the live payroll-quote endpoint at submit
  // time (handleSubmit), so readiness follows the shared live swap gate:
  // open gate = quotable, closed gate = blocked with the gate reason.
  const officialQuoteReady =
    !payrollRoutePolicy.requiresQuote || !crossCurrencyExecutionBlocked;
  const officialQuoteError =
    crossCurrencyExecutionBlockedReason ??
    (officialQuoteRequired ? OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE : null);

  // 2d. Single cross-token target (when exactly one) for row-level messaging.
  const crossCurrencyTarget = useMemo<TokenSymbol | null>(() => {
    const activeSymbol = contract.activeToken.symbol;
    const allRecipients = [state.recipients, ...state.pendingBatches].flat();
    const crossTargets = new Set(
      allRecipients
        .filter((r) => r.targetToken !== activeSymbol && r.amount.trim())
        .map((r) => r.targetToken),
    );
    return crossTargets.size === 1 ? Array.from(crossTargets)[0] : null;
  }, [contract.activeToken.symbol, state.recipients, state.pendingBatches]);

  // 3. Recovery bookkeeping for external-wallet batch submission. A stored
  // hash is returned only after its on-chain receipt is verified as
  // successful; an unverifiable hash fails closed instead of resubmitting.
  const getRecoveredPayrollBatch = useCallback(
    async (batchReferenceId: string) => {
      const stored = readStoredMainnetPayrollBatch(batchReferenceId);
      if (!stored || !stored.txHash || !isTransactionHash(stored.txHash)) {
        return null;
      }
      if (!publicClient) {
        throw new Error(
          "Arc Mainnet public client is not ready to verify payroll recovery. " +
            "Retry once the network client is available; no new transaction was submitted.",
        );
      }

      const receipt = await publicClient.getTransactionReceipt({
        hash: stored.txHash as Hex,
      });
      if (receipt.status !== "success") {
        return null;
      }

      return stored.txHash;
    },
    [publicClient],
  );

  const recordPayrollBatchConfirmation = useCallback(
    async (batchReferenceId: string, txHash: string) => {
      if (!isTransactionHash(txHash)) {
        throw new Error("Payroll transaction hash is invalid.");
      }
      if (!publicClient) {
        throw new Error(
          "Arc Mainnet public client is not ready to confirm payroll. " +
            "Retry once the network client is available.",
        );
      }

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash as Hex,
        confirmations: 1,
      });
      if (receipt.status !== "success") {
        throw new Error(
          "Payroll batch transaction reverted on Arc Mainnet. No payout was recorded.",
        );
      }

      writeStoredMainnetPayrollBatch(batchReferenceId, {
        status: "confirmed",
        txHash,
        updatedAt: new Date().toISOString(),
      });
    },
    [publicClient],
  );

  const beginPayrollBatchSubmission = useCallback(
    async (batchReferenceId: string) => {
      if (readStoredMainnetPayrollBatch(batchReferenceId)) {
        return;
      }
      writeStoredMainnetPayrollBatch(batchReferenceId, {
        status: "submitted",
        txHash: null,
        updatedAt: new Date().toISOString(),
      });
    },
    [],
  );

  const clearPayrollBatchSubmission = useCallback(
    async (batchReferenceId: string) => {
      removeStoredMainnetPayrollBatch(batchReferenceId);
    },
    [],
  );

  // 4. Batch orchestration. No off-chain pre-swap is wired: same-token
  // payroll submits directly, and cross-token payroll executes atomically
  // inside the Mainnet payroll contract once the pool gate passes. Until
  // then the blocked gates below keep Send disabled with a clear reason.
  const batchPayroll = useBatchPayroll({
    activeToken: contract.activeToken,
    approveBatchAmount: contract.requestApproval,
    currentAllowance: contract.currentAllowance,
    feeBps: contract.feeBps,
    recipients: state.recipients,
    pendingBatches: state.pendingBatches,
    referenceId: state.referenceId,
    refetchAllowance: contract.refetchAllowance,
    setStatusMessage: state.setStatusMessage,
    setErrorMessage: state.setErrorMessage,
    submitCurrentBatch: contract.handleSubmit,
    officialQuoteRequired,
    officialQuoteReady,
    officialQuoteError,
    crossCurrencyExecutionBlocked,
    crossCurrencyExecutionBlockedReason,
    getRecoveredPayrollBatch,
    recordPayrollBatchConfirmation,
    beginPayrollBatchSubmission,
    clearPayrollBatchSubmission,
  });

  // 5. History.
  const history = useWizPayHistory({
    activeToken: contract.activeToken,
  });

  // 6. Composer preview while the cross-token route is blocked: zeroed
  // amounts with per-row reasons instead of estimated outputs.
  const blockedQuoteSummary = useMemo<QuoteSummary>(
    () => ({
      estimatedAmountsOut: preparedRecipients.map(() => 0n),
      totalEstimatedOut: 0n,
      totalFees: 0n,
    }),
    [preparedRecipients],
  );

  const quotePreviewBlocked = officialQuoteRequired;
  const quoteSummary = quotePreviewBlocked
    ? blockedQuoteSummary
    : contract.quoteSummary;

  const rowDiagnostics = useMemo<(string | null)[]>(() => {
    if (!crossCurrencyExecutionBlocked) {
      return contract.rowDiagnostics;
    }
    return preparedRecipients.map((recipient) =>
      recipient.targetToken !== contract.activeToken.symbol
        ? (crossCurrencyExecutionBlockedReason ??
          OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE)
        : null,
    );
  }, [
    contract.activeToken.symbol,
    contract.rowDiagnostics,
    crossCurrencyExecutionBlocked,
    crossCurrencyExecutionBlockedReason,
    preparedRecipients,
  ]);

  const hasRouteIssue = crossCurrencyExecutionBlocked;
  const swapProviderLabel =
    payrollRoutePolicy.kind === "external-wallet-mainnet-atomic"
      ? "Arc Mainnet atomic"
      : null;

  const isBusy =
    (batchPayroll.isRunning && !batchPayroll.fxStatus?.recoverableError) ||
    state.approvalState === "signing" ||
    state.approvalState === "confirming" ||
    state.submitState === "simulating" ||
    state.submitState === "wallet" ||
    state.submitState === "confirming";

  const smartBatchCount = batchPayroll.task?.totalUnits ?? state.totalBatches;
  const smartBatchButtonText = batchPayroll.fxStatus?.recoverableError
    ? "Retry verification"
    : batchPayroll.isRunning
      ? (batchPayroll.progress.label ?? "Sending...")
      : "Send";
  // Approval preview must be fee-inclusive for same-token payroll, otherwise
  // the UI predicts 1 confirmation while the chain requires approval + batch.
  const smartBatchFeeInclusiveTotal = useMemo(() => {
    const allSameToken = preparedRecipients.every(
      (recipient) => recipient.targetToken === contract.activeToken.symbol,
    );
    if (!allSameToken || preparedRecipients.length === 0) {
      return batchPayroll.totalAmount;
    }
    let total = 0n;
    for (const recipient of preparedRecipients) {
      total +=
        recipient.amountUnits +
        (recipient.amountUnits * contract.feeBps) / 10_000n;
    }
    return total;
  }, [
    batchPayroll.totalAmount,
    contract.activeToken.symbol,
    contract.feeBps,
    preparedRecipients,
  ]);
  const requiresSmartBatchApproval =
    smartBatchFeeInclusiveTotal > 0n &&
    contract.currentAllowance < smartBatchFeeInclusiveTotal;
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
      ? "Preparing payroll..."
      : state.submitState === "wallet"
        ? "Confirm in wallet..."
        : state.submitState === "confirming"
          ? "Waiting for Arc Mainnet confirmation..."
          : state.submitState === "confirmed"
            ? "Batch Sent"
            : "Send";

  const approvalText =
    state.approvalState === "signing"
      ? "Approve in wallet..."
      : state.approvalState === "confirming"
        ? "Confirming approval..."
        : state.approvalState === "confirmed" && !contract.needsApproval
          ? "Approval confirmed"
          : `Approve ${state.selectedToken}`;

  // ── Dev-only Mainnet route diagnostic ────────────────────────────
  useEffect(() => {
    if (process.env.NODE_ENV === "production") {
      return;
    }
    const canSend = batchPayroll.isSupported && Boolean(batchPayroll.execute);
    const disabledReasons: string[] = [];
    if (isBusy) disabledReasons.push("isBusy");
    if (batchPayroll.isRunning) disabledReasons.push("smartBatchRunning");
    if (contract.insufficientBalance)
      disabledReasons.push("insufficientBalance");
    if (!canSend) disabledReasons.push("!canSend");

    logMainnetPayrollRoute("[mainnet-payroll-route] gating diagnostic", {
      walletConnected: Boolean(walletAddress),
      activeToken: contract.activeToken.symbol,
      crossCurrencyTarget: crossCurrencyTarget ?? null,
      routeKind: payrollRoutePolicy.kind,
      quoteRequired: officialQuoteRequired,
      quoteReady: officialQuoteReady,
      quoteError: officialQuoteError,
      executionBlocked: crossCurrencyExecutionBlocked,
      blockedReason: crossCurrencyExecutionBlockedReason,
      batchAmount: batchAmount.toString(),
      canSend,
      isBusy,
      disabledReasons:
        disabledReasons.length > 0
          ? disabledReasons
          : ["none — button should be enabled"],
    });
  }, [
    batchAmount,
    batchPayroll.execute,
    batchPayroll.isRunning,
    batchPayroll.isSupported,
    contract.activeToken.symbol,
    contract.insufficientBalance,
    crossCurrencyExecutionBlocked,
    crossCurrencyExecutionBlockedReason,
    crossCurrencyTarget,
    isBusy,
    officialQuoteError,
    officialQuoteReady,
    officialQuoteRequired,
    payrollRoutePolicy.kind,
    walletAddress,
  ]);

  // 7. Return unified state matching the previous monolithic footprint.
  return {
    ...state,
    preparedRecipients,
    ...contract,
    ...history,
    ...(quotePreviewBlocked || crossCurrencyExecutionBlocked
      ? {
          quoteSummary,
          quoteLoading: false,
          quoteRefreshing: false,
          rowDiagnostics,
          hasRouteIssue,
        }
      : {}),
    batchAmount,
    validRecipientCount,
    isBusy,
    resetComposer,
    dismissSuccessModal,
    primaryActionText,
    approvalText,
    smartBatchAvailable: batchPayroll.isSupported,
    smartBatchRunning:
      batchPayroll.isRunning && !batchPayroll.fxStatus?.recoverableError,
    smartBatchReason: batchPayroll.availabilityReason,
    smartBatchButtonText,
    smartBatchHelperText,
    // Cross-currency route label ("Arc Mainnet atomic"), null for direct.
    swapProviderLabel,
    smartBatchSubmissionHashes: batchPayroll.submissionHashes,
    payrollTaskId: batchPayroll.taskId,
    payrollTask: batchPayroll.task,
    handleSmartBatchSubmit: batchPayroll.fxStatus?.recoverableError
      ? batchPayroll.recoverFxSettlement
      : batchPayroll.execute,
  };
}
