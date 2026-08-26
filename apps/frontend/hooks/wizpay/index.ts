import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";
import {
  formatUnits,
  getAddress,
  isAddress,
  type Hex,
} from "viem";
import type { QuoteSummary, WizPayState } from "@/lib/types";

import { ERC20_ABI } from "@/constants/erc20";
import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useWizPayState } from "./useWizPayState";
import { useWizPayContract } from "./useWizPayContract";
import { useWizPayHistory } from "./useWizPayHistory";
import { useBatchPayroll, type PreSwapResult } from "./useBatchPayroll";
import { isStableFxMode } from "@/lib/fx-config";
import { arcTestnet } from "@/lib/wagmi";
import {
  quoteUserSwap,
  USER_SWAP_CHAIN,
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
  createAppWalletXylonetOperation,
  quoteAppWalletSwap,
  quoteAppWalletXylonetSwap,
} from "@/lib/app-wallet-swap-service";
import { runAppWalletXylonetLifecycle } from "@/lib/app-wallet-xylonet-lifecycle";
import {
  readVerifiedXylonetPayrollOutput,
  validateXylonetPayrollQuote,
  validateXylonetPayrollOperation,
} from "@/lib/app-wallet-payroll-xylonet";
import { resolvePayrollRoutePolicy } from "@/lib/payroll-route-policy";
import {
  beginExternalPayrollBatchSubmission,
  clearExternalPayrollBatchSubmission,
  getRecoveredExternalPayrollBatch,
  recordExternalPayrollBatchConfirmation,
  runExternalPayrollXylonetSwap,
  type ExternalPayrollXylonetBinding,
} from "@/lib/external-payroll-xylonet";
import { WIZPAY_SWAP_EXECUTOR_V2_ABI } from "@/lib/external-xylonet-swap";

const OFFICIAL_PAYROLL_QUOTE_UNAVAILABLE =
  "Official payroll route quote unavailable. Payroll cannot proceed.";

type PayrollQuoteProvider = "stablefx" | "swapkit" | "xylonet";

// Human-readable label for the StableFX quote provider.
const STABLEFX_PROVIDER_LABEL = "StableFX";

// Legacy fallback text for unsupported cross-currency execution providers.
// StableFX payroll execution is now supported for both External Wallet and
// App Wallet paths when a valid quote is ready.
const STABLEFX_EXECUTION_PENDING_MESSAGE =
  "StableFX quote ready, but cross-currency payroll execution is not available yet. Send is disabled until the StableFX execution provider is implemented.";
const PAYROLL_FX_DEBUG =
  process.env.NEXT_PUBLIC_PAYROLL_FX_DEBUG === "true";

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
  if (!PAYROLL_FX_DEBUG) return;

  if (error) {
    console.debug(label, value, error);
    return;
  }

  console.debug(label, value);
}

export function useWizPay(): WizPayState {
  // 1. Initialize UI / Local State
  const state = useWizPayState();
  const { referenceId, setStatusMessage } = state;
  const preparedRecipients = state.preparedRecipients;

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
    userToken,
  } = useCircleWallet();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { data: walletClient } = useWalletClient();

  // 2b. Determine the payroll route before scheduling any provider request.
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

  const payrollRoutePolicy = useMemo(
    () =>
      resolvePayrollRoutePolicy({
        walletMode,
        sourceToken: contract.activeToken.symbol,
        targetTokens: [state.recipients, ...state.pendingBatches]
          .flat()
          .filter((recipient) => recipient.amount.trim())
          .map((recipient) => recipient.targetToken),
      }),
    [
      contract.activeToken.symbol,
      state.pendingBatches,
      state.recipients,
      walletMode,
    ],
  );

  const externalWalletAddress = useMemo(() => {
    if (walletMode !== "external" || !walletAddress || !isAddress(walletAddress)) {
      return null;
    }

    return getAddress(walletAddress);
  }, [walletAddress, walletMode]);

  // Quote preview address is used only for App Wallet XyloNet requests.
  const quotePreviewAddress = useMemo(() => {
    if (!walletAddress || !isAddress(walletAddress)) {
      return null;
    }

    return getAddress(walletAddress);
  }, [walletAddress]);

  const [officialQuote, setOfficialQuote] = useState<{
    targetToken: TokenSymbol | null;
    provider: PayrollQuoteProvider | null;
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
      !payrollRoutePolicy.requiresQuote ||
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

    const payrollProvider = "xylonet";

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
      "[official-payroll-route] XyloNet quote request",
      {
        tokenIn: contract.activeToken.symbol,
        tokenOut: crossCurrencyTarget,
        amountIn: crossCurrencyAmount,
        walletAddress: quotePreviewAddress,
      },
    );

    const quotePromise = payrollRoutePolicy.kind === "app-wallet-xylonet"
      ? arcWallet?.id && userToken
        ? quoteAppWalletXylonetSwap({
            idempotencyKey: crypto.randomUUID(),
            walletId: arcWallet.id,
            walletAddress: quotePreviewAddress,
            chain: APP_WALLET_SWAP_CHAIN,
            tokenIn: contract.activeToken.symbol,
            tokenOut: crossCurrencyTarget,
            amountIn: crossCurrencyAmount,
            slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
          }, userToken)
        : Promise.reject(new Error("App Wallet payroll provider is unavailable."))
      : quoteUserSwap({
          tokenIn: contract.activeToken.symbol,
          tokenOut: crossCurrencyTarget,
          amountIn: crossCurrencyAmount,
          fromAddress: quotePreviewAddress,
          toAddress: quotePreviewAddress,
          chain: USER_SWAP_CHAIN,
          slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
        });

    quotePromise
      .then((result) => {
        if (cancelled) return;
        const provider = getUserSwapProvider(result);
        const normalizedProvider: PayrollQuoteProvider | null =
          provider === "stablefx" || provider === "swapkit" || provider === "xylonet"
            ? provider
            : null;
        if (normalizedProvider !== payrollProvider) {
          throw new Error(
            `Payroll quote provider mismatch: selected ${payrollProvider}, received ${normalizedProvider}.`,
          );
        }
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
    walletMode,
    arcWallet?.id,
    userToken,
    payrollRoutePolicy.kind,
    payrollRoutePolicy.requiresQuote,
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

  const externalPayrollBindingRef =
    useRef<ExternalPayrollXylonetBinding | null>(null);

  const executePreSwap = useCallback(
    async (params: {
      sourceToken: TokenSymbol;
      targetToken: TokenSymbol;
      amount: string;
      routingAmount: string;
      minimumRequiredOutput: string;
    }): Promise<PreSwapResult> => {
      if (!externalWalletAddress) {
        throw new Error("Wallet address is not available for swap.");
      }
      if (!publicClient || !walletClient) {
        throw new Error("External browser wallet is not ready for payroll swap.");
      }
      const assertExternalWallet = () => {
        const accountAddress = walletClient.account?.address;
        if (walletClient.chain?.id !== arcTestnet.id) {
          throw new Error("Switch the external wallet to Arc Testnet.");
        }
        if (
          !accountAddress ||
          accountAddress.toLowerCase() !== externalWalletAddress.toLowerCase()
        ) {
          throw new Error(
            "The connected external wallet does not match the payroll payer.",
          );
        }
      };
      assertExternalWallet();

      const binding: ExternalPayrollXylonetBinding = {
        referenceId,
        walletAddress: externalWalletAddress,
        chainId: arcTestnet.id,
        tokenIn: params.sourceToken,
        tokenOut: params.targetToken,
        tokenInAddress: SUPPORTED_TOKENS[params.sourceToken].address,
        tokenOutAddress: SUPPORTED_TOKENS[params.targetToken].address,
        amountIn: params.routingAmount,
        minimumRequiredOutput: params.minimumRequiredOutput,
        recipients: [state.recipients, ...state.pendingBatches]
          .flat()
          .filter((recipient) => recipient.amount.trim())
          .map((recipient) => ({
            id: recipient.id,
            address: recipient.address,
            targetToken: recipient.targetToken,
            sourceAmount: parseAmountToUnits(
              recipient.amount,
              contract.activeToken.decimals,
            ).toString(),
          })),
      };
      externalPayrollBindingRef.current = binding;

      const result = await runExternalPayrollXylonetSwap({
        binding,
        storage: window.localStorage,
        quote: () =>
          quoteUserSwap({
            tokenIn: params.sourceToken,
            tokenOut: params.targetToken,
            amountIn: params.routingAmount,
            fromAddress: externalWalletAddress,
            toAddress: externalWalletAddress,
            chain: USER_SWAP_CHAIN,
            slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
          }),
        actions: {
          assertWallet: assertExternalWallet,
          readAllowance: async (token, owner, spender) =>
            (await publicClient.readContract({
              address: token,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [owner, spender],
            })) as bigint,
          submitApproval: (token, spender, amount) =>
            walletClient.writeContract({
              address: token,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [spender, amount],
              account: externalWalletAddress,
              chain: arcTestnet,
            }),
          submitSwap: (quote) =>
            walletClient.writeContract({
              address: quote.executor,
              abi: WIZPAY_SWAP_EXECUTOR_V2_ABI,
              functionName: "executeSwap",
              args: [
                quote.router,
                quote.tokenIn,
                quote.tokenOut,
                quote.amountIn,
                quote.minimumAmountOut,
                quote.recipient,
                quote.deadline,
              ],
              account: externalWalletAddress,
              chain: arcTestnet,
            }),
          waitForReceipt: (hash) =>
            publicClient.waitForTransactionReceipt({
              hash,
              confirmations: 1,
            }),
        },
      });

      return {
        settledToken: params.targetToken,
        txHash: result.txHash,
        provider: "xylonet",
        outputToken: params.targetToken,
        verifiedActualOutput: result.verifiedActualOutput,
      };

    },
    [
      contract.activeToken.decimals,
      externalWalletAddress,
      publicClient,
      referenceId,
      state.pendingBatches,
      state.recipients,
      walletClient,
    ],
  );

  const executeAppWalletPreSwap = useCallback(
    async (params: {
      sourceToken: TokenSymbol;
      targetToken: TokenSymbol;
      amount: string;
      routingAmount: string;
      minimumRequiredOutput: string;
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

      const provider = "xylonet";
      if (!provider || officialQuote.provider !== provider) {
        throw new Error(
          `Payroll provider mismatch: selected ${provider ?? "none"}, quoted ${officialQuote.provider ?? "none"}.`,
        );
      }

      if (provider === "xylonet") {
        if (!userToken) {
          throw new Error("Circle User-Controlled session is unavailable.");
        }
        const request = {
          idempotencyKey: crypto.randomUUID(),
          walletId: arcWallet.id,
          walletAddress,
          chain: APP_WALLET_SWAP_CHAIN,
          tokenIn: params.sourceToken,
          tokenOut: params.targetToken,
          amountIn: params.amount,
          slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
        } as const;
        const quote = await quoteAppWalletXylonetSwap(request, userToken);
        validateXylonetPayrollQuote(quote, {
          sourceToken: params.sourceToken,
          targetToken: params.targetToken,
          amountIn: params.amount,
          walletAddress,
        });

        const operation = await createAppWalletXylonetOperation(request, userToken);
        validateXylonetPayrollOperation(operation, {
          sourceToken: params.sourceToken,
          targetToken: params.targetToken,
          amountIn: params.amount,
          walletAddress,
        });

        let latestOperation = operation;
        let completed;
        try {
          completed = await runAppWalletXylonetLifecycle({
            initialOperation: operation,
            userToken,
            executeChallenge,
            onOperation: (next) => { latestOperation = next; },
            onRequestStatus: (status) => {
              setStatusMessage(status === "idle" ? null : `XyloNet Payroll swap: ${status}...`);
            },
          });
        } catch (error) {
          if (
            latestOperation.lifecycleStage === "swap_submitted" ||
            latestOperation.lifecycleStage === "output_verified" ||
            latestOperation.lifecycleStage === "completed"
          ) {
            throw new PayrollFxRecoveryError(
              error instanceof Error ? error.message : String(error),
              {
                settlementTxHash: latestOperation.swapTransactionHash ?? null,
                step: "xylonet_swap_submitted",
              },
            );
          }
          throw error;
        }
        if (!completed.swapTransactionHash || !isTransactionHash(completed.swapTransactionHash)) {
          throw new Error(
            completed.failureReason ?? "XyloNet Payroll swap did not reach confirmed completion.",
          );
        }
        const verifiedActualOutput = readVerifiedXylonetPayrollOutput(completed, {
          sourceToken: params.sourceToken,
          targetToken: params.targetToken,
          amountIn: params.amount,
          walletAddress,
        });
        return {
          settledToken: params.targetToken,
          txHash: completed.swapTransactionHash as Hex,
          provider: "xylonet",
          outputToken: completed.tokenOut,
          verifiedActualOutput,
        };
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
        provider: "stablefx",
      });
      if (
        fundingQuote.provider !== "stablefx" ||
        !fundingQuote.treasuryDepositAddress
      ) {
        throw new Error("StableFX Payroll funding quote validation failed.");
      }

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
      const fundingReferenceId = `PAYROLL-FX-FUND-${referenceId}-${params.sourceToken}`;
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
            "[official-payroll-route] App Wallet StableFX funding resolver inputs",
            {
              provider: "stablefx",
              step: "app_wallet_funding_resolve",
              sourceToken: params.sourceToken,
              targetToken: params.targetToken,
              fundingReferenceId,
              destinationAddress: fundingQuote.treasuryDepositAddress,
              expectedAmount: fundingAmount,
              expectedTokenId: tokenBalance.tokenId,
              circleTransactionId: circleTransactionId ? "present" : "missing",
              challengeId: fundingChallenge.challengeId,
            },
          );

          logOfficialQuoteDiagnostic(
            "[official-payroll-route] No direct txHash — starting resolveCircleFundingTxHash",
            {
              provider: "stablefx",
              step: "app_wallet_funding_resolve",
              sourceToken: params.sourceToken,
              targetToken: params.targetToken,
              fundingReferenceId,
              circleTransactionId: circleTransactionId ?? null,
              challengeId: fundingChallenge.challengeId,
              walletId: arcWallet.id,
              destinationAddress: fundingQuote.treasuryDepositAddress,
              expectedAmount: fundingAmount,
              expectedTokenId: tokenBalance.tokenId,
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
            expectedTokenId: tokenBalance.tokenId,
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
                  expectedTokenId: tokenBalance.tokenId,
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
          provider: "stablefx",
          sourceToken: params.sourceToken,
          targetToken: params.targetToken,
          sourceAmount: params.amount,
          routingAmount: params.routingAmount,
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
        if (
          !/^\d+$/.test(result.targetAmount) ||
          BigInt(result.targetAmount) < BigInt(params.minimumRequiredOutput)
        ) {
          throw new Error("StableFX output cannot cover the required Payroll payout.");
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
      arcWallet,
      createTransferChallenge,
      ensureSessionReady,
      executeChallenge,
      getWalletBalances,
      publicClient,
      referenceId,
      setStatusMessage,
      officialQuote.provider,
      userToken,
      walletAddress,
    ],
  );

  const getPreSwapPayoutAmounts = useCallback(
    (targetToken: TokenSymbol) => {
      if (
        !crossCurrencyTarget ||
        targetToken !== crossCurrencyTarget ||
        !officialQuote.expectedOutputUnits ||
        (payrollRoutePolicy.kind === "external-wallet-xylonet" &&
          !officialQuote.minimumOutputUnits)
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
        payrollRoutePolicy.kind === "external-wallet-xylonet"
          ? officialQuote.minimumOutputUnits!
          : officialQuote.expectedOutputUnits,
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
      officialQuote.minimumOutputUnits,
      payrollRoutePolicy.kind,
      state.recipients,
      state.pendingBatches,
    ],
  );

  // ── Cross-currency quote and execution availability ─────────────────
  // Only App Wallet cross-token payroll enters the XyloNet quote lifecycle.
  // Same-token payroll stays direct; External cross-token payroll fails locally.
  const officialQuotePreviewEnabled = payrollRoutePolicy.requiresQuote;
  const appWalletCrossCurrencyExecutionSupported = true;

  const officialQuoteRequired = payrollRoutePolicy.requiresQuote;
  // officialQuoteReady means the preview quote resolved with a usable output.
  // It drives the "They Receive" preview and proportional row allocation for
  // BOTH providers. Execution readiness is gated separately below.
  const officialQuoteReady = Boolean(
    officialQuoteRequired &&
      officialQuote.expectedOutputUnits &&
      (payrollRoutePolicy.kind !== "external-wallet-xylonet" ||
        officialQuote.minimumOutputUnits) &&
      !officialQuote.loading &&
      !officialQuote.error,
  );

  // Active provider behind the cross-currency quote.
  const officialQuoteProvider = officialQuote.provider;
  const officialQuoteProviderLabel =
    officialQuoteProvider === "stablefx"
      ? STABLEFX_PROVIDER_LABEL
      : officialQuoteProvider === "xylonet"
        ? "XyloNet Direct"
        : null;

  // StableFX payroll execution is available for both wallet modes:
  // External Wallet uses the browser-wallet executePreSwap path, and App
  // Wallet uses treasury-mediated settlement through PayrollFxSettlementService.
  const isStablefxCrossCurrency =
    officialQuoteRequired && officialQuoteProvider === "stablefx";
  const stablefxPayrollExecutionSupported = true;
  const crossCurrencyExecutionBlocked =
    isStablefxCrossCurrency && !stablefxPayrollExecutionSupported;
  const crossCurrencyExecutionBlockedReason = crossCurrencyExecutionBlocked
    ? payrollRoutePolicy.blockedReason ?? STABLEFX_EXECUTION_PENDING_MESSAGE
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

    // Quote and policy diagnostics for cross-currency rows.
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
    // Reserved for unsupported cross-currency execution providers while the
    // preview amounts remain populated.
    if (crossCurrencyExecutionBlocked) {
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

  const getRecoveredPayrollBatch = useCallback(
    async (batchReferenceId: string) => {
      const binding = externalPayrollBindingRef.current;
      if (!binding || !publicClient) return null;
      return getRecoveredExternalPayrollBatch({
        binding,
        storage: window.localStorage,
        referenceId: batchReferenceId,
        waitForReceipt: (hash) =>
          publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
          }),
      });
    },
    [publicClient],
  );

  const recordPayrollBatchConfirmation = useCallback(
    async (batchReferenceId: string, txHash: string) => {
      const binding = externalPayrollBindingRef.current;
      if (!binding) {
        throw new Error("External Wallet payroll recovery binding is unavailable.");
      }
      if (!isTransactionHash(txHash)) {
        throw new Error("External Wallet payroll transaction hash is invalid.");
      }
      if (!publicClient) {
        throw new Error("Arc public client is unavailable for payroll confirmation.");
      }
      await recordExternalPayrollBatchConfirmation({
        binding,
        storage: window.localStorage,
        referenceId: batchReferenceId,
        txHash: txHash as Hex,
        waitForReceipt: (hash) =>
          publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
          }),
      });
    },
    [publicClient],
  );

  const beginPayrollBatchSubmission = useCallback(
    async (batchReferenceId: string) => {
      const binding = externalPayrollBindingRef.current;
      if (!binding) {
        throw new Error("External Wallet payroll recovery binding is unavailable.");
      }
      beginExternalPayrollBatchSubmission({
        binding,
        storage: window.localStorage,
        referenceId: batchReferenceId,
      });
    },
    [],
  );

  const clearPayrollBatchSubmission = useCallback(
    async (batchReferenceId: string) => {
      const binding = externalPayrollBindingRef.current;
      if (!binding) return;
      clearExternalPayrollBatchSubmission({
        binding,
        storage: window.localStorage,
        referenceId: batchReferenceId,
      });
    },
    [],
  );

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
      payrollRoutePolicy.kind === "app-wallet-xylonet"
        ? executeAppWalletPreSwap
        : payrollRoutePolicy.kind === "external-wallet-xylonet"
          ? executePreSwap
          : undefined,
    getPreSwapPayoutAmounts: getPreSwapPayoutAmounts,
    officialQuoteRequired,
    officialQuoteReady,
    officialQuoteError: appWalletCrossCurrencyBlocked
      ? appWalletCrossCurrencyMessage
      : officialQuoteIssue,
    crossCurrencyExecutionBlocked,
    crossCurrencyExecutionBlockedReason,
    getRecoveredPayrollBatch:
      payrollRoutePolicy.kind === "external-wallet-xylonet"
        ? getRecoveredPayrollBatch
        : undefined,
    recordPayrollBatchConfirmation:
      payrollRoutePolicy.kind === "external-wallet-xylonet"
        ? recordPayrollBatchConfirmation
        : undefined,
    beginPayrollBatchSubmission:
      payrollRoutePolicy.kind === "external-wallet-xylonet"
        ? beginPayrollBatchSubmission
        : undefined,
    clearPayrollBatchSubmission:
      payrollRoutePolicy.kind === "external-wallet-xylonet"
        ? clearPayrollBatchSubmission
        : undefined,
  });

  // 3. Initialize History
  const history = useWizPayHistory({
    activeToken: contract.activeToken,
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
    if (!PAYROLL_FX_DEBUG) return;
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

    console.debug("[app-wallet-gating-diagnostic]", {
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
    // Override quote state for the App Wallet XyloNet lifecycle and surface
    // local policy diagnostics for unsupported External cross-token rows.
    ...(officialQuotePreviewEnabled || crossCurrencyExecutionBlocked
      ? {
          quoteSummary: officialQuotePreviewEnabled
            ? officialQuoteSummary ?? {
                estimatedAmountsOut: preparedRecipients.map(() => 0n),
                totalEstimatedOut: 0n,
                totalFees: 0n,
              }
            : contract.quoteSummary,
          quoteLoading: officialQuotePreviewEnabled
            ? officialQuote.loading
            : contract.quoteLoading,
          quoteRefreshing: officialQuotePreviewEnabled
            ? officialQuote.loading
            : contract.quoteRefreshing,
          rowDiagnostics:
            officialQuoteDiagnostics ?? preparedRecipients.map(() => null),
          hasRouteIssue: Boolean(
            officialQuoteIssue ||
              appWalletCrossCurrencyBlocked ||
              crossCurrencyExecutionBlocked,
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
