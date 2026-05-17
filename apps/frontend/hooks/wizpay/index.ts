import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";
import { getAddress, isAddress } from "viem";
import type { QuoteSummary, WizPayState } from "@/lib/types";

import { useWizPayState } from "./useWizPayState";
import { useWizPayContract } from "./useWizPayContract";
import { useWizPayHistory } from "./useWizPayHistory";
import { useBatchPayroll, type PreSwapResult } from "./useBatchPayroll";
import { useResolvedRecipients } from "./useResolvedRecipients";
import { isStableFxMode } from "@/lib/fx-config";
import { arcTestnet } from "@/lib/wagmi";
import {
  createArcSwapAdapter,
  executePreparedArcUserSwap,
  type CircleSwapToken,
} from "@/lib/circle-swap-kit";
import {
  prepareUserSwap,
  quoteUserSwap,
  USER_SWAP_CHAIN,
  type UserSwapQuoteRequest,
} from "@/lib/user-swap-service";
import {
  getUserSwapExpectedOutputValue,
  getUserSwapMinimumOutputValue,
  parseUserSwapQuoteAmount,
} from "@/lib/user-swap-quote-parser";
import {
  parseAmountToUnits,
  PREVIEW_SLIPPAGE_BPS,
  SUPPORTED_TOKENS,
  type TokenSymbol,
} from "@/lib/wizpay";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { BackendApiError } from "@/lib/backend-api";

const OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE =
  "Official payroll route quote unavailable. Payroll cannot proceed.";

function isPositiveDecimal(value: string) {
  return parseFloat(value) > 0 && Number.isFinite(Number(value));
}

function allocateQuoteOutput(
  totalOutputUnits: bigint,
  sourceAmounts: bigint[],
) {
  const totalSource = sourceAmounts.reduce((sum, amount) => sum + amount, 0n);

  if (totalSource <= 0n) {
    return sourceAmounts.map(() => 0n);
  }

  let allocated = 0n;

  return sourceAmounts.map((amount, index) => {
    if (index === sourceAmounts.length - 1) {
      return totalOutputUnits - allocated;
    }

    const recipientOutput = (totalOutputUnits * amount) / totalSource;
    allocated += recipientOutput;
    return recipientOutput;
  });
}

function logOfficialQuoteDiagnostic(
  label: string,
  value: unknown,
  error?: unknown,
) {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  if (error) {
    console.warn(label, value, error);
    return;
  }

  console.info(label, value);
}

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

  // 2a. External Wallet Swap adapter for cross-currency payroll
  const { walletAddress, walletMode } = useActiveWalletAddress();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { data: walletClient } = useWalletClient();

  const swapAdapter = useMemo(
    () => createArcSwapAdapter(publicClient, walletClient),
    [publicClient, walletClient],
  );

  // 2b. Official cross-currency quote for External Wallet payroll
  // Uses the same quoteUserSwap path as the working Swap page.
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

  const crossCurrencyAmount = useMemo<string>(() => {
    if (!crossCurrencyTarget) return "0";
    const allRecipients = [state.recipients, ...state.pendingBatches].flat();
    let totalUnits = 0n;

    for (const r of allRecipients) {
      if (r.targetToken === crossCurrencyTarget) {
        try {
          const parsedUnits = parseAmountToUnits(
            r.amount,
            contract.activeToken.decimals,
          );
          if (parsedUnits > 0n) totalUnits += parsedUnits;
        } catch {
          // Invalid draft amounts are handled by the normal row validation path.
        }
      }
    }

    return totalUnits.toString();
  }, [
    contract.activeToken.decimals,
    crossCurrencyTarget,
    state.recipients,
    state.pendingBatches,
  ]);

  const externalWalletAddress = useMemo(() => {
    if (walletMode !== "external" || !walletAddress || !isAddress(walletAddress)) {
      return null;
    }

    return getAddress(walletAddress);
  }, [walletAddress, walletMode]);

  const [officialQuote, setOfficialQuote] = useState<{
    targetToken: TokenSymbol | null;
    expectedOutput: string | null;
    expectedOutputUnits: bigint | null;
    minimumOutput: string | null;
    minimumOutputUnits: bigint | null;
    loading: boolean;
    error: string | null;
  }>({
    targetToken: null,
    expectedOutput: null,
    expectedOutputUnits: null,
    minimumOutput: null,
    minimumOutputUnits: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    if (
      !crossCurrencyTarget ||
      contract.activeToken.symbol === crossCurrencyTarget ||
      !externalWalletAddress ||
      !isPositiveDecimal(crossCurrencyAmount)
    ) {
      queueMicrotask(() => {
        if (cancelled) return;
        setOfficialQuote({
          targetToken: null,
          expectedOutput: null,
          expectedOutputUnits: null,
          minimumOutput: null,
          minimumOutputUnits: null,
          loading: false,
          error: null,
        });
      });
      return () => {
        cancelled = true;
      };
    }

    const payload: UserSwapQuoteRequest = {
      tokenIn: contract.activeToken.symbol,
      tokenOut: crossCurrencyTarget,
      amountIn: crossCurrencyAmount,
      fromAddress: externalWalletAddress,
      toAddress: externalWalletAddress,
      chain: USER_SWAP_CHAIN,
    };

    queueMicrotask(() => {
      if (cancelled) return;
      setOfficialQuote((prev) => ({
        ...prev,
        targetToken: crossCurrencyTarget,
        loading: true,
        error: null,
      }));
    });
    logOfficialQuoteDiagnostic(
      "[official-payroll-route] quoteUserSwap payload",
      payload,
    );

    quoteUserSwap(payload)
      .then((result) => {
        if (cancelled) return;
        const expectedOutputValue = getUserSwapExpectedOutputValue(result);
        const minimumOutputValue = getUserSwapMinimumOutputValue(result);
        const expectedOutputParsed = parseUserSwapQuoteAmount(
          expectedOutputValue,
          crossCurrencyTarget,
        );
        const minimumOutputParsed = parseUserSwapQuoteAmount(
          minimumOutputValue,
          crossCurrencyTarget,
        );
        const expectedOutput = expectedOutputParsed?.displayAmount ?? null;
        const minimumOutput = minimumOutputParsed?.displayAmount ?? null;
        const expectedOutputUnits = expectedOutputParsed?.units ?? null;
        const minimumOutputUnits = minimumOutputParsed?.units ?? null;

        logOfficialQuoteDiagnostic(
          "[official-payroll-route] quoteUserSwap response",
          {
            rawExpectedOutput: expectedOutputParsed?.rawAmount ?? null,
            rawMinimumOutput: minimumOutputParsed?.rawAmount ?? null,
            expectedOutput,
            expectedOutputUnits: expectedOutputUnits?.toString() ?? null,
            minimumOutput,
            minimumOutputUnits: minimumOutputUnits?.toString() ?? null,
          },
        );

        setOfficialQuote({
          targetToken: crossCurrencyTarget,
          expectedOutput,
          expectedOutputUnits,
          minimumOutput,
          minimumOutputUnits,
          loading: false,
          error: expectedOutputUnits
            ? null
            : OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        logOfficialQuoteDiagnostic(
          "[official-payroll-route] quoteUserSwap error",
          error instanceof BackendApiError
            ? {
                status: error.status,
                body: error.responseBody ?? {
                  error: error.message,
                  code: error.code,
                  details: error.details,
                },
              }
            : error,
          error,
        );
        setOfficialQuote({
          targetToken: crossCurrencyTarget,
          expectedOutput: null,
          expectedOutputUnits: null,
          minimumOutput: null,
          minimumOutputUnits: null,
          loading: false,
          error: OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    crossCurrencyTarget,
    crossCurrencyAmount,
    externalWalletAddress,
    contract.activeToken.symbol,
  ]);

  // Build official quote summary override for cross-currency
  const officialQuoteSummary = useMemo<QuoteSummary | null>(() => {
    if (!crossCurrencyTarget) return null;

    const sourceDecimals = contract.activeToken.decimals;
    const targetDecimals = SUPPORTED_TOKENS[crossCurrencyTarget].decimals;
    const allRecipients = [state.recipients, ...state.pendingBatches].flat();
    const crossRecipients = allRecipients.filter(
      (r) => r.targetToken === crossCurrencyTarget && r.amount.trim(),
    );

    if (!officialQuote.expectedOutputUnits) {
      return {
        estimatedAmountsOut: allRecipients
          .filter((r) => r.amount.trim())
          .map(() => 0n),
        totalEstimatedOut: 0n,
        totalFees: 0n,
      };
    }

    const crossSourceAmounts = crossRecipients.map((recipient) =>
      parseAmountToUnits(recipient.amount, sourceDecimals),
    );
    const crossEstimatedAmounts = allocateQuoteOutput(
      officialQuote.expectedOutputUnits,
      crossSourceAmounts,
    );
    const crossRecipientOutput = new Map<string, bigint>();
    crossRecipients.forEach((recipient, index) => {
      crossRecipientOutput.set(
        recipient.id,
        crossEstimatedAmounts[index] ?? 0n,
      );
    });

    const estimatedAmountsOut: bigint[] = allRecipients
      .filter((r) => r.amount.trim())
      .map((r) => {
        if (r.targetToken === contract.activeToken.symbol) {
          // Same-token: 1:1
          return parseAmountToUnits(r.amount, sourceDecimals);
        }
        return crossRecipientOutput.get(r.id) ?? 0n;
      });

    const totalEstimatedOut = estimatedAmountsOut.reduce(
      (sum, a) => sum + a,
      0n,
    );

    // Fees: difference between input and output for cross-currency portion
    const crossInputTotal = crossRecipients.reduce(
      (sum, r) => sum + parseAmountToUnits(r.amount, sourceDecimals),
      0n,
    );
    const normalizedExpectedOutput =
      targetDecimals === sourceDecimals
        ? officialQuote.expectedOutputUnits
        : 0n;
    const totalFees =
      crossInputTotal > normalizedExpectedOutput
        ? crossInputTotal - normalizedExpectedOutput
        : 0n;

    return { estimatedAmountsOut, totalEstimatedOut, totalFees };
  }, [
    crossCurrencyTarget,
    officialQuote.expectedOutputUnits,
    contract.activeToken.decimals,
    contract.activeToken.symbol,
    state.recipients,
    state.pendingBatches,
  ]);

  const executePreSwap = useCallback(
    async (params: {
      sourceToken: TokenSymbol;
      targetToken: TokenSymbol;
      amount: string;
    }): Promise<PreSwapResult> => {
      if (!swapAdapter) {
        throw new Error(
          "Swap adapter is not ready. Connect your external wallet first.",
        );
      }

      if (!externalWalletAddress) {
        throw new Error("Wallet address is not available for swap.");
      }

      const preparePayload = {
        tokenIn: params.sourceToken,
        tokenOut: params.targetToken,
        amountIn: params.amount,
        fromAddress: externalWalletAddress,
        toAddress: externalWalletAddress,
        chain: USER_SWAP_CHAIN,
        slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
      } as const;

      logOfficialQuoteDiagnostic(
        "[official-payroll-route] prepareUserSwap payload",
        preparePayload,
      );

      let prepared;
      try {
        prepared = await prepareUserSwap(preparePayload);
      } catch (error) {
        logOfficialQuoteDiagnostic(
          "[official-payroll-route] prepareUserSwap error",
          error instanceof BackendApiError
            ? {
                status: error.status,
                body: error.responseBody ?? {
                  error: error.message,
                  code: error.code,
                  details: error.details,
                },
              }
            : error,
          error,
        );
        throw error;
      }

      // Step 2: Execute via the official adapter (user's wallet signs)
      let txHash: string | null | undefined;
      try {
        txHash = await executePreparedArcUserSwap({
          adapter: swapAdapter,
          prepared,
          tokenIn: params.sourceToken as CircleSwapToken,
        });
      } catch (error) {
        logOfficialQuoteDiagnostic(
          "[official-payroll-route] adapter execution error",
          error,
          error,
        );
        throw error;
      }

      logOfficialQuoteDiagnostic(
        "[official-payroll-route] pre-swap txHash",
        txHash ?? null,
      );

      if (txHash && publicClient) {
        await publicClient.waitForTransactionReceipt({
          hash: txHash as `0x${string}`,
          confirmations: 1,
        });
      }

      return {
        settledToken: params.targetToken,
        txHash: txHash ?? null,
      };
    },
    [swapAdapter, externalWalletAddress, publicClient],
  );

  const getPreSwapPayoutAmounts = useCallback(
    (targetToken: TokenSymbol) => {
      if (
        !crossCurrencyTarget ||
        targetToken !== crossCurrencyTarget ||
        !officialQuote.expectedOutputUnits
      ) {
        return null;
      }

      const allRecipients = [state.recipients, ...state.pendingBatches].flat();
      const crossRecipients = allRecipients.filter(
        (recipient) =>
          recipient.targetToken === targetToken && recipient.amount.trim(),
      );
      const sourceAmounts = crossRecipients.map((recipient) =>
        parseAmountToUnits(recipient.amount, contract.activeToken.decimals),
      );
      const allocatedAmounts = allocateQuoteOutput(
        officialQuote.expectedOutputUnits,
        sourceAmounts,
      );
      const payoutAmounts = new Map<string, string>();

      crossRecipients.forEach((recipient, index) => {
        payoutAmounts.set(
          recipient.id,
          allocatedAmounts[index]?.toString() ?? "0",
        );
      });

      return payoutAmounts;
    },
    [
      contract.activeToken.decimals,
      crossCurrencyTarget,
      officialQuote.expectedOutputUnits,
      state.recipients,
      state.pendingBatches,
    ],
  );

  const officialQuoteRequired =
    walletMode === "external" && Boolean(crossCurrencyTarget);
  const officialQuoteReady = Boolean(
    officialQuoteRequired &&
      officialQuote.expectedOutputUnits &&
      !officialQuote.loading &&
      !officialQuote.error,
  );
  const officialQuoteIssue = officialQuoteRequired
    ? officialQuote.error ??
      (officialQuote.loading
        ? null
        : crossCurrencyTarget
          ? `Official quote unavailable for ${contract.activeToken.symbol} -> ${crossCurrencyTarget} aggregate amount.`
          : OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE)
    : null;
  const officialQuoteDiagnostics = officialQuoteIssue
    ? preparedRecipients.map((recipient) =>
        recipient.targetToken !== contract.activeToken.symbol
          ? officialQuoteIssue
          : null,
      )
    : officialQuoteRequired && officialQuote.loading
      ? preparedRecipients.map((recipient) =>
          recipient.targetToken !== contract.activeToken.symbol
            ? "Loading official payroll route quote..."
            : null,
        )
      : officialQuoteRequired
        ? preparedRecipients.map((recipient) =>
            recipient.targetToken !== contract.activeToken.symbol
              ? null // Quote succeeded — no diagnostic needed
              : null,
          )
        : null;

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
    executePreSwap: walletMode === "external" ? executePreSwap : undefined,
    getPreSwapPayoutAmounts:
      walletMode === "external" ? getPreSwapPayoutAmounts : undefined,
    officialQuoteRequired,
    officialQuoteReady,
    officialQuoteError: officialQuoteIssue,
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
    // Override quote with official source when cross-currency is detected
    ...(officialQuoteRequired
      ? {
          quoteSummary: officialQuoteSummary ?? {
            estimatedAmountsOut: preparedRecipients.map(() => 0n),
            totalEstimatedOut: 0n,
            totalFees: 0n,
          },
          quoteLoading: officialQuote.loading,
          quoteRefreshing: officialQuote.loading,
          rowDiagnostics:
            officialQuoteDiagnostics ?? preparedRecipients.map(() => null),
          hasRouteIssue: Boolean(officialQuoteIssue),
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
