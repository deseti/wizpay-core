import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import { usePublicClient, useReadContract } from "wagmi";

import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useTransactionExecutor } from "@/hooks/useTransactionExecutor";

import { WIZPAY_ABI, WIZPAY_BATCH_PAYMENT_ROUTED_EVENT } from "@/constants/abi";
import { WIZPAY_ADDRESS } from "@/constants/addresses";
import { ERC20_ABI } from "@/constants/erc20";
import {
  PREVIEW_SLIPPAGE_BPS,
  SUPPORTED_TOKENS,
  getFriendlyErrorMessage,
  parseAmountToUnits,
  type RecipientDraft,
  type TokenSymbol,
} from "@/lib/wizpay";
import type {
  PreparedRecipient,
  QuoteSummary,
  TransactionActionResult,
} from "@/lib/types";
import type { useWizPayState } from "./useWizPayState";
import { isStableFxMode, fxProviderLabel } from "@/lib/fx-config";
import { arcTestnet } from "@/lib/wagmi";

type BaseState = ReturnType<typeof useWizPayState>;

const EMPTY_QUOTE_SUMMARY: QuoteSummary = {
  estimatedAmountsOut: [],
  totalEstimatedOut: 0n,
  totalFees: 0n,
};

const MAX_CONFIRMATION_POLLS = 20;
const POLL_INTERVAL_MS = 1500;

type PreparedBatchRecipient = {
  address: Address;
  amountUnits: bigint;
  id: string;
  targetToken: TokenSymbol;
  validAddress: boolean;
};

type PayrollEventLog = {
  transactionHash: Hex | null;
  args: {
    referenceId?: string;
  };
};

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function logPayrollRouteDiagnostic(label: string, value: unknown) {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  console.info(label, value);
}

function getTokenSymbolByAddress(address: Address): TokenSymbol | null {
  const normalizedAddress = address.toLowerCase();
  const match = Object.values(SUPPORTED_TOKENS).find(
    (token) => token.address.toLowerCase() === normalizedAddress,
  );

  return match?.symbol ?? null;
}

/**
 * useWizPayContract — Read-only chain queries + user-controlled execution.
 *
 * This hook now:
 * 1. Reads on-chain data for display (balances, allowances, quotes, fees)
 * 2. Requests approval from the active wallet when needed
 * 3. Executes payroll batches client-side via Circle user-controlled or external wallets
 */
export function useWizPayContract({
  state,
  batchAmount,
  preparedRecipients,
}: {
  state: BaseState;
  batchAmount: bigint;
  preparedRecipients: PreparedRecipient[];
}) {
  const { walletAddress, walletMode } = useActiveWalletAddress();
  const { executeTransaction } = useTransactionExecutor();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const activeToken = SUPPORTED_TOKENS[state.selectedToken];
  const allowanceSpender = WIZPAY_ADDRESS;

  // ── Read-only on-chain queries (for UI display only) ────────────

  const {
    data: currentAllowanceData,
    refetch: refetchAllowance,
    isLoading: allowanceQueryLoading,
  } = useReadContract({
    address: activeToken.address,
    abi: ERC20_ABI,
    chainId: arcTestnet.id,
    functionName: "allowance",
    args: walletAddress ? [walletAddress, allowanceSpender] : undefined,
    query: {
      enabled: !!walletAddress,
      staleTime: 10_000,
      placeholderData: keepPreviousData,
    },
  });

  const {
    data: currentBalanceData,
    refetch: refetchBalance,
    isLoading: balanceQueryLoading,
  } = useReadContract({
    address: activeToken.address,
    abi: ERC20_ABI,
    chainId: arcTestnet.id,
    functionName: "balanceOf",
    args: walletAddress ? [walletAddress] : undefined,
    query: {
      enabled: !!walletAddress,
      staleTime: 10_000,
      placeholderData: keepPreviousData,
    },
  });

  const { data: feeBpsData, isLoading: feeQueryLoading } = useReadContract({
    address: WIZPAY_ADDRESS,
    abi: WIZPAY_ABI,
    chainId: arcTestnet.id,
    functionName: "feeBps",
    query: {
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    },
  });

  useEffect(() => {
    refetchAllowance();
  }, [state.currentBatchNumber, refetchAllowance]);

  // ── Derived values ──────────────────────────────────────────────

  const currentAllowance = currentAllowanceData ?? 0n;
  const currentBalance = currentBalanceData ?? 0n;
  const approvalAmount = batchAmount;

  // ── Quote summary (simplified — no longer drives execution) ─────

  const rawQuoteEnabled = Boolean(
    walletAddress &&
    preparedRecipients.length > 0 &&
    batchAmount > 0n &&
    preparedRecipients.every((r) => r.amountUnits > 0n) &&
    preparedRecipients.every((r) => r.targetToken === activeToken.symbol),
  );

  const {
    data: rawQuoteData,
    isLoading: rawQuoteLoading,
    isFetching: rawQuoteFetching,
  } = useReadContract({
    address: WIZPAY_ADDRESS,
    abi: WIZPAY_ABI,
    chainId: arcTestnet.id,
    functionName: "getBatchEstimatedOutputs",
    args: [
      activeToken.address,
      preparedRecipients.map((r) => SUPPORTED_TOKENS[r.targetToken].address),
      preparedRecipients.map((r) => r.amountUnits),
    ],
    query: {
      enabled: rawQuoteEnabled && !isStableFxMode,
      refetchInterval: 20_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
      staleTime: 20_000,
      placeholderData: keepPreviousData,
    },
  });

  const quoteSummary = useMemo<QuoteSummary>(() => {
    if (!rawQuoteData) return EMPTY_QUOTE_SUMMARY;
    return {
      estimatedAmountsOut: [...rawQuoteData[0]],
      totalEstimatedOut: rawQuoteData[1],
      totalFees: rawQuoteData[2],
    };
  }, [rawQuoteData]);

  const feeBps = feeBpsData ?? 0n;

  // ── Loading / diagnostic states ─────────────────────────────────

  const allowanceLoading = Boolean(walletAddress) && allowanceQueryLoading;
  const balanceLoading = Boolean(walletAddress) && balanceQueryLoading;
  const feeLoading = feeQueryLoading;
  const engineLoading = false;
  const quoteLoading = rawQuoteEnabled && rawQuoteLoading;
  const quoteRefreshing = Boolean(rawQuoteFetching && rawQuoteData);

  const rowDiagnostics = useMemo<(string | null)[]>(() => {
    return preparedRecipients.map(() => null);
  }, [preparedRecipients]);

  const hasRouteIssue = false;
  const needsApproval =
    approvalAmount > 0n && currentAllowance < approvalAmount;
  const insufficientBalance = currentBalance < batchAmount;

  const prepareBatchRecipients = (
    batchRecipients?: RecipientDraft[],
  ): PreparedBatchRecipient[] => {
    if (!batchRecipients) {
      return preparedRecipients.map((recipient) => ({
        address: (recipient.normalizedAddress ?? recipient.address) as Address,
        amountUnits: recipient.amountUnits,
        id: recipient.id,
        targetToken: recipient.targetToken,
        validAddress: recipient.validAddress,
      }));
    }

    const sourceRecipients = batchRecipients ?? state.recipients;

    return sourceRecipients.map((recipient) => {
      const trimmedAddress = recipient.address.trim();
      const normalizedAddress = isAddress(trimmedAddress)
        ? getAddress(trimmedAddress)
        : null;
      const amountDecimals = SUPPORTED_TOKENS[recipient.targetToken].decimals;

      return {
        address: (normalizedAddress ?? trimmedAddress) as Address,
        amountUnits: parseAmountToUnits(recipient.amount, amountDecimals),
        id: recipient.id,
        targetToken: recipient.targetToken,
        validAddress: Boolean(normalizedAddress),
      };
    });
  };

  const waitForAllowanceUpdate = async (
    requiredAmount: bigint,
    txHash: Hex | null,
  ) => {
    if (!publicClient) {
      throw new Error("Arc public client is not ready yet.");
    }

    if (txHash) {
      await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });
    }

    for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
      const result = await refetchAllowance();
      const nextAllowance = result.data ?? 0n;

      if (nextAllowance >= requiredAmount) {
        return;
      }

      if (attempt < MAX_CONFIRMATION_POLLS - 1) {
        await waitFor(POLL_INTERVAL_MS);
      }
    }

    throw new Error(
      "Approval completed, but the allowance did not refresh before the timeout window ended.",
    );
  };

  const waitForBatchSettlement = async ({
    referenceId,
    startBlock,
    txHash,
  }: {
    referenceId: string;
    startBlock: bigint;
    txHash: Hex | null;
  }) => {
    if (!publicClient || !walletAddress) {
      throw new Error("Arc public client is not ready yet.");
    }

    if (txHash) {
      try {
        await publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 1,
        });
        return txHash;
      } catch {
        // Fall through to the event-based confirmation path.
      }
    }

    for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
      const logs = (await publicClient.getLogs({
        address: WIZPAY_ADDRESS,
        event: WIZPAY_BATCH_PAYMENT_ROUTED_EVENT,
        args: { sender: walletAddress },
        fromBlock: startBlock,
      })) as PayrollEventLog[];

      const matchedLog = logs.find(
        (log) =>
          Boolean(log.transactionHash) && log.args.referenceId === referenceId,
      );

      if (matchedLog?.transactionHash) {
        return matchedLog.transactionHash;
      }

      if (attempt < MAX_CONFIRMATION_POLLS - 1) {
        await waitFor(POLL_INTERVAL_MS);
      }
    }

    if (txHash) {
      return txHash;
    }

    throw new Error(
      "Circle completed the wallet challenge, but the Arc settlement event did not appear before the timeout window ended.",
    );
  };

  const getMinimumAmountsOut = async (
    preparedRecipients: PreparedBatchRecipient[],
    batchRecipients?: RecipientDraft[],
  ) => {
    const canUseCachedQuote =
      (!batchRecipients || batchRecipients === state.recipients) &&
      !quoteLoading &&
      !quoteRefreshing &&
      quoteSummary.estimatedAmountsOut.length === preparedRecipients.length;

    if (canUseCachedQuote) {
      return quoteSummary.estimatedAmountsOut.map((estimatedAmountOut) => {
        if (estimatedAmountOut <= 0n) {
          return 0n;
        }

        return (estimatedAmountOut * (10000n - PREVIEW_SLIPPAGE_BPS)) / 10000n;
      });
    }

    if (!publicClient || preparedRecipients.length === 0) {
      return preparedRecipients.map(() => 0n);
    }

    const quote = (await publicClient.readContract({
      address: WIZPAY_ADDRESS,
      abi: WIZPAY_ABI,
      functionName: "getBatchEstimatedOutputs",
      args: [
        activeToken.address,
        preparedRecipients.map(
          (recipient) => SUPPORTED_TOKENS[recipient.targetToken].address,
        ),
        preparedRecipients.map((recipient) => recipient.amountUnits),
      ],
    })) as readonly [readonly bigint[], bigint, bigint];

    return [...quote[0]].map((estimatedAmountOut) => {
      if (estimatedAmountOut <= 0n) {
        return 0n;
      }

      return (estimatedAmountOut * (10000n - PREVIEW_SLIPPAGE_BPS)) / 10000n;
    });
  };

  const applyBatchSessionTotals = (
    preparedRecipients: PreparedBatchRecipient[],
    batchTotalAmount: bigint,
    batchValidRecipientCount: number,
  ) => {
    state.setSessionTotalAmount((prev) => prev + batchTotalAmount);
    state.setSessionTotalRecipients((prev) => prev + batchValidRecipientCount);
    state.setSessionTotalDistributed((prev) => {
      const next = { ...prev };

      for (const recipient of preparedRecipients) {
        next[recipient.targetToken] += recipient.amountUnits;
      }

      return next;
    });
  };

  // ── Actions (user-controlled wallet execution) ──────────────────

  const requestApproval = async (
    amount = approvalAmount,
  ): Promise<TransactionActionResult> => {
    if (!walletAddress) {
      const message = "Connect the active wallet before approving payroll.";
      state.setErrorMessage(message);
      return { ok: false, hash: null };
    }

    if (!publicClient) {
      const message = "Arc public client is not ready yet.";
      state.setErrorMessage(message);
      return { ok: false, hash: null };
    }

    state.setApprovalState("signing");
    state.setApproveTxHash(null);
    state.setErrorMessage(null);
    state.setStatusMessage(
      `Confirm the ${activeToken.symbol} approval in your wallet.`,
    );

    try {
      const approvalResult = await executeTransaction({
        abi: ERC20_ABI,
        args: [WIZPAY_ADDRESS, amount],
        chainId: arcTestnet.id,
        contractAddress: activeToken.address,
        functionName: "approve",
        refId: `PAYROLL-APPROVE-${Date.now()}`,
      });

      state.setApprovalState("confirming");
      state.setApproveTxHash(approvalResult.txHash);
      state.setStatusMessage("Waiting for approval confirmation on Arc...");

      await waitForAllowanceUpdate(amount, approvalResult.txHash);

      state.setApprovalState("confirmed");
      state.setStatusMessage(null);

      return {
        ok: true,
        hash: approvalResult.txHash ?? approvalResult.hash,
      };
    } catch (error) {
      const message = getFriendlyErrorMessage(error);

      state.setApprovalState("idle");
      state.setApproveTxHash(null);
      state.setErrorMessage(message);
      state.setStatusMessage(null);

      return { ok: false, hash: null };
    }
  };

  const handleApprove = async (): Promise<TransactionActionResult> => {
    return requestApproval(approvalAmount);
  };

  /**
   * Submit a payroll batch through the active user-controlled wallet.
   */
  const handleSubmit = async (
    batchRecipients?: RecipientDraft[],
    batchReferenceId?: string,
  ): Promise<TransactionActionResult> => {
    if (
      (!batchRecipients && !state.validate(preparedRecipients)) ||
      hasRouteIssue
    ) {
      return { ok: false, hash: null };
    }

    if (!walletAddress) {
      state.setErrorMessage(
        "Connect the active wallet before sending payroll.",
      );
      return { ok: false, hash: null };
    }

    if (!publicClient) {
      state.setErrorMessage("Arc public client is not ready yet.");
      return { ok: false, hash: null };
    }

    const batchPreparedRecipients = prepareBatchRecipients(batchRecipients);

    const batchTotalAmount = batchPreparedRecipients.reduce(
      (sum, recipient) => sum + recipient.amountUnits,
      0n,
    );
    const batchValidRecipientCount = batchPreparedRecipients.filter(
      (recipient) => recipient.validAddress,
    ).length;
    const referenceId = (batchReferenceId ?? state.referenceId).trim();

    if (
      batchPreparedRecipients.length === 0 ||
      batchTotalAmount === 0n ||
      batchValidRecipientCount !== batchPreparedRecipients.length
    ) {
      state.setErrorMessage(
        "Review every payroll recipient before submitting this batch.",
      );
      return { ok: false, hash: null };
    }

    // Determine the effective input token for batchRouteAndPay.
    // When all recipients target the same token AND it differs from activeToken,
    // it means a pre-swap has already been executed and the wallet now holds
    // the target token. Use the target token as input for same-token payout.
    const allSameTarget = batchPreparedRecipients.every(
      (r) => r.targetToken === batchPreparedRecipients[0].targetToken,
    );
    const batchTargetToken = batchPreparedRecipients[0]?.targetToken;
    const effectiveTokenIn =
      allSameTarget && batchTargetToken && batchTargetToken !== activeToken.symbol
        ? SUPPORTED_TOKENS[batchTargetToken].address
        : activeToken.address;
    const effectiveTokenInSymbol =
      getTokenSymbolByAddress(effectiveTokenIn) ?? activeToken.symbol;

    logPayrollRouteDiagnostic(
      "[official-payroll-route] final payout effectiveTokenIn",
      {
        symbol: effectiveTokenInSymbol,
        address: effectiveTokenIn,
      },
    );

    let latestAllowance = currentAllowance;
    let latestBalance = currentBalance;

    // When the effective input token differs from activeToken (post-swap scenario),
    // read allowance and balance directly for the effective token.
    if (effectiveTokenIn !== activeToken.address) {
      const [onChainAllowance, onChainBalance] = await Promise.all([
        publicClient.readContract({
          address: effectiveTokenIn,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [walletAddress, allowanceSpender],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: effectiveTokenIn,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        }) as Promise<bigint>,
      ]);
      latestAllowance = onChainAllowance;
      latestBalance = onChainBalance;

      logPayrollRouteDiagnostic(
        "[official-payroll-route] post-swap wallet state",
        {
          token: effectiveTokenInSymbol,
          balance: latestBalance.toString(),
          allowanceToWizPay: latestAllowance.toString(),
          requiredAmount: batchTotalAmount.toString(),
          needsApproval: latestAllowance < batchTotalAmount,
          insufficientBalance: latestBalance < batchTotalAmount,
        },
      );
    } else if (
      currentAllowance < batchTotalAmount ||
      currentBalance < batchTotalAmount
    ) {
      const [latestAllowanceResult, latestBalanceResult] = await Promise.all([
        refetchAllowance(),
        refetchBalance(),
      ]);

      latestAllowance = latestAllowanceResult.data ?? currentAllowance;
      latestBalance = latestBalanceResult.data ?? currentBalance;
    }

    if (latestBalance < batchTotalAmount) {
      const message = `Insufficient ${effectiveTokenInSymbol} balance for this payroll batch. Have ${latestBalance.toString()}, need ${batchTotalAmount.toString()}.`;
      state.setErrorMessage(message);
      return { ok: false, hash: null, error: message };
    }

    if (latestAllowance < batchTotalAmount) {
      // If effective token differs, auto-approve for the target token
      if (effectiveTokenIn !== activeToken.address) {
        logPayrollRouteDiagnostic(
          "[official-payroll-route] auto-approving post-swap token",
          {
            token: batchTargetToken,
            amount: batchTotalAmount.toString(),
            spender: WIZPAY_ADDRESS,
          },
        );
        state.setStatusMessage(
          `Approving ${batchTargetToken} for payroll payout...`,
        );
        try {
          const approvalResult = await executeTransaction({
            abi: ERC20_ABI,
            args: [WIZPAY_ADDRESS, batchTotalAmount],
            chainId: arcTestnet.id,
            contractAddress: effectiveTokenIn,
            functionName: "approve",
            refId: `PAYROLL-APPROVE-${batchTargetToken}-${Date.now()}`,
          });
          if (!approvalResult.hash && !approvalResult.txHash) {
            const message = `Approval for ${batchTargetToken} was not confirmed.`;
            state.setErrorMessage(message);
            return { ok: false, hash: null, error: message };
          }
          const approvalHash = approvalResult.txHash ?? approvalResult.hash;

          logPayrollRouteDiagnostic(
            "[official-payroll-route] approval tx submitted",
            { token: batchTargetToken, txHash: approvalHash },
          );

          if (approvalHash) {
            state.setStatusMessage(
              `Waiting for ${batchTargetToken} approval confirmation on Arc...`,
            );
            await publicClient.waitForTransactionReceipt({
              hash: approvalHash as Hex,
              confirmations: 1,
            });
          }

          for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
            const nextAllowance = (await publicClient.readContract({
              address: effectiveTokenIn,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [walletAddress, allowanceSpender],
            })) as bigint;

            if (nextAllowance >= batchTotalAmount) {
              latestAllowance = nextAllowance;
              break;
            }

            if (attempt < MAX_CONFIRMATION_POLLS - 1) {
              await waitFor(POLL_INTERVAL_MS);
            }
          }

          if (latestAllowance < batchTotalAmount) {
            const message = `Approval for ${batchTargetToken} did not update before the timeout window ended.`;
            state.setErrorMessage(message);
            return { ok: false, hash: null, error: message };
          }
        } catch (approvalError) {
          const message = `Failed to approve ${batchTargetToken}: ${getFriendlyErrorMessage(approvalError)}`;
          state.setErrorMessage(message);
          return { ok: false, hash: null, error: message };
        }
      } else {
        const message = `Approve ${activeToken.symbol} before submitting this payroll batch.`;
        state.setErrorMessage(message);
        return { ok: false, hash: null, error: message };
      }
    }

    const tokenOuts = batchPreparedRecipients.map(
      (recipient) => SUPPORTED_TOKENS[recipient.targetToken].address,
    );
    const recipients = batchPreparedRecipients.map(
      (recipient) => recipient.address,
    ) as readonly Address[];
    const amountsIn = batchPreparedRecipients.map(
      (recipient) => recipient.amountUnits,
    );

    state.setSubmitState("simulating");
    state.setSubmitTxHash(null);
    state.setErrorMessage(null);
    state.setStatusMessage(
      "Preparing the payroll batch for wallet confirmation...",
    );

    try {
      // For same-token payout after pre-swap, minimum amounts must account for
      // the on-chain fee deduction. The contract calculates:
      //   amountAfterFee = amountIn - (amountIn * feeBps / 10000)
      // and reverts with DirectTransferBelowMinimum if amountAfterFee < minAmountOut.
      const isSameTokenPayout = batchPreparedRecipients.every(
        (recipient) =>
          SUPPORTED_TOKENS[recipient.targetToken].address === effectiveTokenIn,
      );
      const minAmountsOut = isSameTokenPayout
        ? amountsIn.map((a) => {
            if (feeBps <= 0n) return a;
            // Floor: amount after fee deduction
            return (a * (10000n - feeBps)) / 10000n;
          })
        : await getMinimumAmountsOut(
            batchPreparedRecipients,
            batchRecipients,
          );

      logPayrollRouteDiagnostic(
        "[official-payroll-route] batchRouteAndPay args",
        {
          tokenIn: {
            symbol: effectiveTokenInSymbol,
            address: effectiveTokenIn,
          },
          tokenOuts: tokenOuts.map((address) => ({
            symbol: getTokenSymbolByAddress(address),
            address,
          })),
          amounts: amountsIn.map((amount, index) => {
            const token = batchPreparedRecipients[index]?.targetToken;
            const decimals = token ? SUPPORTED_TOKENS[token].decimals : 0;

            return {
              amountUnits: amount.toString(),
              humanAmount: token ? formatUnits(amount, decimals) : null,
              token: token ?? null,
            };
          }),
          minAmountsOut: minAmountsOut.map((amount) => amount.toString()),
          referenceId,
        },
      );

      if (walletMode !== "circle") {
        await publicClient.estimateContractGas({
          address: WIZPAY_ADDRESS,
          abi: WIZPAY_ABI,
          account: walletAddress,
          functionName: "batchRouteAndPay",
          args: [
            effectiveTokenIn,
            tokenOuts,
            recipients,
            amountsIn,
            minAmountsOut,
            referenceId,
          ],
        });
      }

      state.setSubmitState("wallet");
      state.setStatusMessage("Confirm the payroll batch in your wallet.");

      const executionResult = await executeTransaction({
        abi: WIZPAY_ABI,
        args: [
          effectiveTokenIn,
          tokenOuts,
          recipients,
          amountsIn,
          minAmountsOut,
          referenceId,
        ],
        chainId: arcTestnet.id,
        contractAddress: WIZPAY_ADDRESS,
        functionName: "batchRouteAndPay",
        refId: referenceId,
      });

      state.setSubmitState("confirming");
      state.setSubmitTxHash(executionResult.txHash ?? executionResult.hash);
      state.setStatusMessage("Waiting for Arc confirmation...");

      const confirmedHash = await waitForBatchSettlement({
        referenceId,
        startBlock: executionResult.startBlock,
        txHash: executionResult.txHash,
      });
      const finalHash = confirmedHash ?? executionResult.hash;

      state.setSubmitTxHash(finalHash);
      state.setSubmitState("confirmed");
      state.setStatusMessage(null);

      applyBatchSessionTotals(
        batchPreparedRecipients,
        batchTotalAmount,
        batchValidRecipientCount,
      );

      await Promise.all([refetchAllowance(), refetchBalance()]);

      return { ok: true, hash: finalHash };
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      state.setSubmitState("idle");
      state.setErrorMessage(message);
      state.setStatusMessage(null);
      logPayrollRouteDiagnostic(
        "[official-payroll-route] batchRouteAndPay FAILED",
        { error: message, rawError: error },
      );
      return { ok: false, hash: null, error: message };
    }
  };

  return {
    activeToken,
    currentAllowance,
    currentBalance,
    feeBps,
    fxEngineData: undefined,
    engineBalances: { USDC: 0n, EURC: 0n },
    quoteSummary,
    allowanceLoading,
    balanceLoading,
    feeLoading,
    engineLoading,
    quoteLoading,
    quoteRefreshing,
    rowDiagnostics,
    hasRouteIssue,
    needsApproval,
    insufficientBalance,
    handleApprove,
    handleSubmit,
    requestApproval,
    approvalAmount,
    estimatedGas: null as bigint | null,
    refetchAllowance,
    refetchBalance,
    refetchEngineBalances: async () => undefined,
    /** Active FX mode metadata for UI display */
    fxMeta: {
      isStableFxMode,
      providerLabel: fxProviderLabel,
      engineAddress: undefined,
    },
  };
}
