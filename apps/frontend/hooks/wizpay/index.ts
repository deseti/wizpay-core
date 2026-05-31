import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, getAddress, isAddress, type Hex } from "viem";
import type { QuoteSummary, WizPayState } from "@/lib/types";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
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
  type UserSwapProvider,
  type UserSwapQuoteRequest,
} from "@/lib/user-swap-service";
import {
  findFirstString,
  getUserSwapExpectedOutputValue,
  getUserSwapMinimumOutputValue,
  getUserSwapProvider,
  parseUserSwapQuoteAmount,
} from "@/lib/user-swap-quote-parser";
import {
  parseAmountToUnits,
  PREVIEW_SLIPPAGE_BPS,
  SUPPORTED_TOKENS,
  isTransactionHash,
  type TokenSymbol,
} from "@/lib/wizpay";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { BackendApiError } from "@/lib/backend-api";
import {
  settlePayrollFx,
  resolveCircleFundingTxHash,
  PayrollFxRecoveryError,
} from "@/lib/payroll-fx-settlement-service";
import {
  APP_WALLET_SWAP_CHAIN,
  quoteAppWalletSwap,
} from "@/lib/app-wallet-swap-service";

const OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE =
  "Official payroll route quote unavailable. Payroll cannot proceed.";

// Human-readable label for the StableFX quote provider.
const STABLEFX_PROVIDER_LABEL = "StableFX";

// Shown when a cross-currency quote is available from StableFX but the
// StableFX execution provider has not been implemented yet. The quote and
// preview are valid; only execution (Send) is blocked.
const STABLEFX_EXECUTION_PENDING_MESSAGE =
  "StableFX quote ready, but cross-currency payroll execution is not available yet. Send is disabled until the StableFX execution provider is implemented.";

function isPositiveDecimal(value: string) {
  return parseFloat(value) > 0 && Number.isFinite(Number(value));
}

function getCircleTxHash(...values: unknown[]): Hex | null {
  for (const value of values) {
    const candidate =
      findFirstString(value, [
        "data.txHash",
        "data.transactionHash",
        "data.hash",
        "data.transaction.txHash",
        "data.transaction.transactionHash",
        "data.transaction.hash",
        "data.transactions.0.txHash",
        "data.transactions.0.transactionHash",
        "data.transactions.0.hash",
        "transaction.txHash",
        "transaction.transactionHash",
        "transaction.hash",
        "transactions.0.txHash",
        "transactions.0.transactionHash",
        "transactions.0.hash",
        "txHash",
        "transactionHash",
        "hash",
      ]) ?? null;

    if (candidate && isTransactionHash(candidate)) {
      return candidate as Hex;
    }
  }

  return null;
}

function getCircleTransactionId(...values: unknown[]) {
  for (const value of values) {
    const candidate = findFirstString(value, [
      "data.transactionId",
      "data.transaction.id",
      "data.transactions.0.id",
      "data.id",
      "transaction.id",
      "transactions.0.id",
      "transactionId",
      "id",
    ]);

    if (candidate && !isTransactionHash(candidate)) {
      return candidate;
    }
  }

  return null;
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
  const { referenceId, setStatusMessage } = state;
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
  const {
    arcWallet,
    createTransferChallenge,
    ensureSessionReady,
    executeChallenge,
    getWalletBalances,
  } = useCircleWallet();
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

  // Quote preview address: used for official quote requests regardless of wallet mode.
  // Both App Wallet and External Wallet can request quotes for display purposes.
  const quotePreviewAddress = useMemo(() => {
    if (!walletAddress || !isAddress(walletAddress)) {
      return null;
    }

    return getAddress(walletAddress);
  }, [walletAddress]);

  const [officialQuote, setOfficialQuote] = useState<{
    targetToken: TokenSymbol | null;
    provider: UserSwapProvider | null;
    expectedOutput: string | null;
    expectedOutputUnits: bigint | null;
    minimumOutput: string | null;
    minimumOutputUnits: bigint | null;
    loading: boolean;
    error: string | null;
  }>({
    targetToken: null,
    provider: null,
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
      !quotePreviewAddress ||
      !isPositiveDecimal(crossCurrencyAmount)
    ) {
      queueMicrotask(() => {
        if (cancelled) return;
        setOfficialQuote({
          targetToken: null,
          provider: null,
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
      fromAddress: quotePreviewAddress,
      toAddress: quotePreviewAddress,
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
        const provider = getUserSwapProvider(result);
        const normalizedProvider: UserSwapProvider | null =
          provider === "stablefx"
            ? "stablefx"
            : provider === "swapkit"
              ? "swapkit"
              : null;
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
            provider: normalizedProvider,
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
          provider: normalizedProvider,
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
          provider: null,
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
    quotePreviewAddress,
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

  const executeAppWalletPreSwap = useCallback(
    async (params: {
      sourceToken: TokenSymbol;
      targetToken: TokenSymbol;
      amount: string;
    }): Promise<PreSwapResult> => {
      if (!walletAddress) {
        throw new Error(
          "App Wallet address is not available for FX settlement.",
        );
      }

      await ensureSessionReady();

      if (!arcWallet?.id) {
        throw new Error("Arc App Wallet is not ready for payroll funding.");
      }

      logOfficialQuoteDiagnostic(
        "[official-payroll-route] App Wallet payroll funding quote request",
        {
          sourceToken: params.sourceToken,
          targetToken: params.targetToken,
          amount: params.amount,
          walletAddress,
          referenceId,
        },
      );

      const fundingQuote = await quoteAppWalletSwap({
        tokenIn: params.sourceToken,
        tokenOut: params.targetToken,
        amountIn: params.amount,
        fromAddress: walletAddress,
        chain: APP_WALLET_SWAP_CHAIN,
      });

      const balances = await getWalletBalances(arcWallet.id);
      const sourceTokenConfig = SUPPORTED_TOKENS[params.sourceToken];
      const tokenBalance = balances.find((balance) => {
        const symbolMatches = balance.symbol === params.sourceToken;
        const addressMatches =
          balance.tokenAddress?.toLowerCase() ===
          sourceTokenConfig.address.toLowerCase();

        return symbolMatches || addressMatches;
      });

      if (!tokenBalance?.tokenId) {
        throw new Error(
          `${params.sourceToken} token metadata is missing for App Wallet payroll funding.`,
        );
      }

      const fundingAmount = formatUnits(
        BigInt(params.amount),
        sourceTokenConfig.decimals,
      );
      const fundingReferenceId = `PAYROLL-FX-FUND-${referenceId}-${params.targetToken}`;
      const runStartTime = new Date().toISOString();

      setStatusMessage(
        `Funding treasury with ${fundingAmount} ${params.sourceToken} from App Wallet...`,
      );

      const fundingChallenge = await createTransferChallenge({
        walletId: arcWallet.id,
        destinationAddress: fundingQuote.treasuryDepositAddress,
        tokenId: tokenBalance.tokenId,
        amounts: [fundingAmount],
        feeLevel: "HIGH",
        refId: fundingReferenceId,
      });
      const fundingChallengeResult = await executeChallenge(
        fundingChallenge.challengeId,
      );
      let sourceFundingTxHash = getCircleTxHash(
        fundingChallengeResult,
        fundingChallenge.raw,
      );
      const circleTransactionId = getCircleTransactionId(
        fundingChallengeResult,
        fundingChallenge.raw,
      );

      logOfficialQuoteDiagnostic(
        "[official-payroll-route] App Wallet funding challenge result",
        {
          hasTxHash: Boolean(sourceFundingTxHash),
          sourceFundingTxHash: sourceFundingTxHash ?? null,
          hasTransactionId: Boolean(circleTransactionId),
          circleTransactionId: circleTransactionId ?? null,
          challengeId: fundingChallenge.challengeId,
          walletId: arcWallet.id,
          destinationAddress: fundingQuote.treasuryDepositAddress,
          challengeResultType: typeof fundingChallengeResult,
          challengeResultKeys:
            fundingChallengeResult && typeof fundingChallengeResult === "object"
              ? Object.keys(fundingChallengeResult as object)
              : [],
          challengeResultRaw: fundingChallengeResult,
          challengeRawKeys:
            fundingChallenge.raw && typeof fundingChallenge.raw === "object"
              ? Object.keys(fundingChallenge.raw as object)
              : [],
          challengeRaw: fundingChallenge.raw,
        },
      );

      // ── Post-funding continuation (wrapped for recovery context) ──
      // After this point, source funds have been debited. Any failure
      // must surface a recoverable error with tx context.
      const recoveryContext = {
        fundingCircleTxId: circleTransactionId ?? null,
        fundingChallengeId: fundingChallenge.challengeId,
        fundingTxHash: sourceFundingTxHash as string | null,
        settlementTxHash: null as string | null,
        payoutTxHash: null as string | null,
      };

      try {
        if (!sourceFundingTxHash) {
          logOfficialQuoteDiagnostic(
            "[official-payroll-route] No direct txHash — starting resolveCircleFundingTxHash",
            {
              circleTransactionId: circleTransactionId ?? null,
              challengeId: fundingChallenge.challengeId,
              walletId: arcWallet.id,
              destinationAddress: fundingQuote.treasuryDepositAddress,
            },
          );

          setStatusMessage(
            "Funding confirmed. Resolving transaction...",
          );

          sourceFundingTxHash = (await resolveCircleFundingTxHash({
            circleTransactionId,
            challengeId: fundingChallenge.challengeId,
            walletId: arcWallet.id,
            destinationAddress: fundingQuote.treasuryDepositAddress,
            expectedAmount: fundingAmount,
            refId: fundingReferenceId,
            runStartTime,
            onAttempt: (attempt, strategy) => {
              setStatusMessage(
                `Resolving funding transaction... (attempt ${attempt}, ${strategy})`,
              );
              logOfficialQuoteDiagnostic(
                "[official-payroll-route] polling App Wallet payroll funding transaction",
                {
                  attempt,
                  strategy,
                  circleTransactionId,
                  challengeId: fundingChallenge.challengeId,
                  fundingReferenceId,
                  walletId: arcWallet!.id,
                  destinationAddress: fundingQuote.treasuryDepositAddress,
                  expectedAmount: fundingAmount,
                  runStartTime,
                  sourceToken: params.sourceToken,
                },
              );
            },
          })) as Hex;

          recoveryContext.fundingTxHash = sourceFundingTxHash;

          logOfficialQuoteDiagnostic(
            "[official-payroll-route] resolveCircleFundingTxHash SUCCESS",
            { sourceFundingTxHash },
          );
        }

        if (publicClient) {
          logOfficialQuoteDiagnostic(
            "[official-payroll-route] waiting for funding tx on-chain confirmation",
            { sourceFundingTxHash },
          );

          setStatusMessage(
            `Waiting for ${params.sourceToken} funding confirmation on Arc...`,
          );

          await publicClient.waitForTransactionReceipt({
            hash: sourceFundingTxHash,
            confirmations: 1,
          });

          logOfficialQuoteDiagnostic(
            "[official-payroll-route] funding tx confirmed on-chain",
            { sourceFundingTxHash },
          );
        }

        setStatusMessage(
          "Funding confirmed. Executing FX settlement...",
        );

        // Guard: only call settlePayrollFx with a valid EVM txHash
        if (!isTransactionHash(sourceFundingTxHash)) {
          throw new Error(
            `Cannot call FX settlement: sourceFundingTxHash is not a valid EVM hash. ` +
            `Got: ${sourceFundingTxHash}`,
          );
        }

        logOfficialQuoteDiagnostic(
          "[official-payroll-route] calling settlePayrollFx",
          {
            sourceFundingTxHash,
            fundingReferenceId,
            treasuryDepositAddress: fundingQuote.treasuryDepositAddress,
            settleParams: {
              sourceToken: params.sourceToken,
              targetToken: params.targetToken,
              sourceAmount: params.amount,
              referenceId: `PAYROLL-FX-${referenceId}-${params.targetToken}`,
              walletAddress,
            },
          },
        );

        const result = await settlePayrollFx({
          sourceToken: params.sourceToken,
          targetToken: params.targetToken,
          sourceAmount: params.amount,
          referenceId: `PAYROLL-FX-${referenceId}-${params.targetToken}`,
          walletAddress,
          sourceFundingTxHash,
        });

        logOfficialQuoteDiagnostic(
          "[official-payroll-route] settlePayrollFx response",
          {
            status: result.status,
            txHash: result.txHash,
            payoutTxHash: result.payoutTxHash ?? null,
            targetAmount: result.targetAmount,
            sourceAmount: result.sourceAmount,
            sourceToken: result.sourceToken,
            targetToken: result.targetToken,
          },
        );

        recoveryContext.settlementTxHash = result.txHash;

        if (result.status !== "settled" || !result.txHash) {
          throw new Error(
            `App Wallet FX settlement failed: status=${result.status}, txHash=${result.txHash ?? "null"}`,
          );
        }

        const payoutHash = (result.payoutTxHash ?? result.txHash) as Hex;
        recoveryContext.payoutTxHash = payoutHash;

        if (publicClient && payoutHash && isTransactionHash(payoutHash)) {
          setStatusMessage(
            "FX settlement complete. Waiting for target token payout...",
          );

          logOfficialQuoteDiagnostic(
            "[official-payroll-route] waiting for payout tx on-chain confirmation",
            { payoutHash },
          );

          await publicClient.waitForTransactionReceipt({
            hash: payoutHash,
            confirmations: 1,
          });

          logOfficialQuoteDiagnostic(
            "[official-payroll-route] payout tx confirmed on-chain",
            { payoutHash },
          );
        }

        setStatusMessage(
          "Target token received. Submitting payroll...",
        );

        return {
          settledToken: params.targetToken,
          txHash: payoutHash,
        };
      } catch (postFundingError) {
        // Wrap any post-funding error with recovery context
        const originalMessage =
          postFundingError instanceof Error
            ? postFundingError.message
            : String(postFundingError);

        logOfficialQuoteDiagnostic(
          "[official-payroll-route] POST-FUNDING ERROR — wrapping with recovery context",
          { originalMessage, recoveryContext },
        );

        throw new PayrollFxRecoveryError(originalMessage, {
          ...recoveryContext,
          step: recoveryContext.settlementTxHash
            ? "waiting_payout"
            : recoveryContext.fundingTxHash
              ? "settling_fx"
              : "resolving_tx_hash",
        });
      }
    },
    [
      arcWallet?.id,
      createTransferChallenge,
      ensureSessionReady,
      executeChallenge,
      getWalletBalances,
      publicClient,
      referenceId,
      setStatusMessage,
      walletAddress,
    ],
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

  // ── Cross-currency quote and execution availability ─────────────────
  // Quote preview: available for BOTH wallet modes when cross-currency is detected.
  // Execution: available for External Wallet (browser wallet signing) and
  // App Wallet (treasury-mediated server-side swap via PayrollFxSettlementService).

  const officialQuotePreviewEnabled = Boolean(crossCurrencyTarget);
  const appWalletCrossCurrencyExecutionSupported = true;

  // officialQuoteRequired gates execution readiness for both wallet modes
  // when cross-currency is detected.
  const officialQuoteRequired = Boolean(crossCurrencyTarget);
  // officialQuoteReady means the preview quote resolved with a usable output.
  // It drives the "They Receive" preview and proportional row allocation for
  // BOTH providers. Execution readiness is gated separately below.
  const officialQuoteReady = Boolean(
    officialQuoteRequired &&
      officialQuote.expectedOutputUnits &&
      !officialQuote.loading &&
      !officialQuote.error,
  );

  // Active provider behind the cross-currency quote.
  const officialQuoteProvider = officialQuote.provider;
  const officialQuoteProviderLabel =
    officialQuoteProvider === "stablefx"
      ? STABLEFX_PROVIDER_LABEL
      : null;

  // StableFX is quote-only in this phase: the preview is valid, but the
  // execution provider (trade creation / settlement) is not implemented yet.
  // Cross-currency execution must stay blocked while quotes still populate.
  const isStablefxCrossCurrency =
    officialQuoteRequired && officialQuoteProvider === "stablefx";
  const crossCurrencyExecutionBlocked = isStablefxCrossCurrency;
  const crossCurrencyExecutionBlockedReason = crossCurrencyExecutionBlocked
    ? STABLEFX_EXECUTION_PENDING_MESSAGE
    : null;

  // Determine if App Wallet cross-currency should block Send
  const appWalletCrossCurrencyBlocked =
    walletMode === "circle" &&
    Boolean(crossCurrencyTarget) &&
    !appWalletCrossCurrencyExecutionSupported;

  const appWalletCrossCurrencyMessage = appWalletCrossCurrencyBlocked
    ? "App Wallet cross-currency payroll execution is not available yet. Use External Wallet for route-swap payroll."
    : null;

  // A genuine quote problem (error, or resolved with no usable output).
  // A successful quote — including a StableFX quote — is NOT an issue here;
  // StableFX execution gating is handled by crossCurrencyExecutionBlocked.
  const officialQuoteIssue = officialQuoteRequired
    ? officialQuote.loading
      ? null
      : officialQuote.error ??
        (officialQuote.expectedOutputUnits
          ? null
          : crossCurrencyTarget
            ? `Official quote unavailable for ${contract.activeToken.symbol} -> ${crossCurrencyTarget} aggregate amount.`
            : OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE)
    : null;

  // Row diagnostics for cross-currency recipients
  const officialQuoteDiagnostics = (() => {
    // App Wallet cross-currency: show execution-blocked message on cross rows
    if (appWalletCrossCurrencyBlocked) {
      if (officialQuote.loading) {
        return preparedRecipients.map((recipient) =>
          recipient.targetToken !== contract.activeToken.symbol
            ? "Loading official payroll route quote..."
            : null,
        );
      }
      if (officialQuote.error || !officialQuote.expectedOutputUnits) {
        return preparedRecipients.map((recipient) =>
          recipient.targetToken !== contract.activeToken.symbol
            ? officialQuote.error ??
              `Official quote unavailable for ${contract.activeToken.symbol} -> ${crossCurrencyTarget}.`
            : null,
        );
      }
      // Quote succeeded but execution not available
      return preparedRecipients.map((recipient) =>
        recipient.targetToken !== contract.activeToken.symbol
          ? appWalletCrossCurrencyMessage
          : null,
      );
    }

    // External Wallet cross-currency
    if (officialQuoteIssue) {
      return preparedRecipients.map((recipient) =>
        recipient.targetToken !== contract.activeToken.symbol
          ? officialQuoteIssue
          : null,
      );
    }
    if (officialQuoteRequired && officialQuote.loading) {
      return preparedRecipients.map((recipient) =>
        recipient.targetToken !== contract.activeToken.symbol
          ? "Loading official payroll route quote..."
          : null,
      );
    }
    // Quote resolved (e.g. StableFX), but cross-currency execution is not
    // available yet. Show the execution-pending note on cross rows while the
    // preview amounts remain populated.
    if (officialQuoteRequired && crossCurrencyExecutionBlocked) {
      return preparedRecipients.map((recipient) =>
        recipient.targetToken !== contract.activeToken.symbol
          ? crossCurrencyExecutionBlockedReason
          : null,
      );
    }
    if (officialQuoteRequired) {
      return preparedRecipients.map((recipient) =>
        recipient.targetToken !== contract.activeToken.symbol
          ? null // Quote succeeded — no diagnostic needed
          : null,
      );
    }

    return null;
  })();

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
    executePreSwap:
      walletMode === "external"
        ? executePreSwap
        : walletMode === "circle"
          ? executeAppWalletPreSwap
          : undefined,
    getPreSwapPayoutAmounts: getPreSwapPayoutAmounts,
    officialQuoteRequired,
    officialQuoteReady,
    officialQuoteError: appWalletCrossCurrencyBlocked
      ? appWalletCrossCurrencyMessage
      : officialQuoteIssue,
    // StableFX is quote-only: keep Send disabled for cross-currency execution
    // while the preview still populates from the resolved quote.
    crossCurrencyExecutionBlocked,
    crossCurrencyExecutionBlockedReason,
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

  // ── Dev-only App Wallet gating diagnostic ──────────────────────────
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const allRecipients = [state.recipients, ...state.pendingBatches].flat();
    const targetTokens = Array.from(
      new Set(allRecipients.map((r) => r.targetToken)),
    );
    const canSend = batchPayroll.isSupported && Boolean(batchPayroll.execute);
    const disabledReasons: string[] = [];
    if (isBusy) disabledReasons.push("isBusy");
    if (batchPayroll.isRunning) disabledReasons.push("smartBatchRunning");
    if (contract.insufficientBalance) disabledReasons.push("insufficientBalance");
    if (!canSend) disabledReasons.push("!canSend (smartBatchAvailable=" + String(batchPayroll.isSupported) + ")");

    console.info("[app-wallet-gating-diagnostic]", {
      walletMode,
      walletAddress: walletAddress ?? null,
      activeToken: contract.activeToken.symbol,
      recipientCount: allRecipients.length,
      targetTokens,
      crossCurrencyTarget: crossCurrencyTarget ?? null,
      batchAmount: batchAmount.toString(),
      currentBalance: contract.currentBalance.toString(),
      currentAllowance: contract.currentAllowance.toString(),
      insufficientBalance: contract.insufficientBalance,
      officialQuoteRequired,
      officialQuotePreviewEnabled,
      officialQuoteReady,
      officialQuoteLoading: officialQuote.loading,
      officialQuoteError: officialQuote.error ?? null,
      officialQuoteIssue: officialQuoteIssue ?? null,
      appWalletCrossCurrencyBlocked,
      appWalletCrossCurrencyExecutionSupported,
      "batchPayroll.isSupported": batchPayroll.isSupported,
      smartBatchAvailable: batchPayroll.isSupported,
      handleSmartBatchSubmitExists: Boolean(batchPayroll.execute),
      canSend,
      isBusy,
      disabledReasons: disabledReasons.length > 0 ? disabledReasons : ["none — button should be enabled"],
      theyReceiveSource: officialQuotePreviewEnabled
        ? officialQuote.expectedOutputUnits
          ? "official quote"
          : officialQuote.loading
            ? "loading"
            : "unavailable"
        : "same-token (no quote needed)",
    });
  }, [
    walletMode,
    walletAddress,
    contract.activeToken.symbol,
    contract.currentBalance,
    contract.currentAllowance,
    contract.insufficientBalance,
    state.recipients,
    state.pendingBatches,
    batchAmount,
    crossCurrencyTarget,
    officialQuoteRequired,
    officialQuotePreviewEnabled,
    officialQuoteReady,
    officialQuote.loading,
    officialQuote.error,
    officialQuote.expectedOutputUnits,
    officialQuoteIssue,
    appWalletCrossCurrencyBlocked,
    appWalletCrossCurrencyExecutionSupported,
    batchPayroll.isSupported,
    batchPayroll.isRunning,
    batchPayroll.execute,
    isBusy,
  ]);

  // 4. Return unified state matching the previous monolithic footprint
  return {
    ...state,
    preparedRecipients,
    ...contract,
    ...history,
    // Override quote with official source when cross-currency is detected
    // Applies to BOTH wallet modes so "They Receive" shows real quote output
    ...(officialQuotePreviewEnabled
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
          hasRouteIssue: Boolean(
            officialQuoteIssue || appWalletCrossCurrencyBlocked,
          ),
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
    smartBatchRunning: batchPayroll.isRunning && !batchPayroll.fxStatus?.recoverableError,
    smartBatchReason: batchPayroll.availabilityReason,
    smartBatchButtonText,
    smartBatchHelperText,
    // Cross-currency quote provider label (e.g. "StableFX"), null otherwise.
    swapProviderLabel: officialQuoteProviderLabel,
    smartBatchSubmissionHashes: batchPayroll.submissionHashes,
    payrollTaskId: batchPayroll.taskId,
    payrollTask: batchPayroll.task,
    handleSmartBatchSubmit: batchPayroll.fxStatus?.recoverableError
      ? batchPayroll.recoverFxSettlement
      : batchPayroll.execute,
  };
}
