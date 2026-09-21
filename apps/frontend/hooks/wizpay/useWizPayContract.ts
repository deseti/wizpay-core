import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  getAddress,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { usePublicClient, useReadContract } from "wagmi";

import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useTransactionExecutor } from "@/hooks/useTransactionExecutor";

import { WIZPAY_ABI } from "@/constants/abi";
import { WIZPAY_PAYROLL_MAINNET_ABI } from "@/constants/generated/wizpay-payroll-mainnet.abi";
import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";
import {
  nativePayrollValue,
  payrollApprovalTarget,
  sameTokenFunding,
} from "@/lib/mainnet-payroll-protocol";
import { calculateMinHopPriceX36 } from "@/lib/mainnet-uniswap-v4-protocol";
import {
  acquireExecutionIntent,
  bindExecutionIntentTransactionHash,
} from "@/lib/execution-intent";
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
import { activeArcChain } from "@/lib/wagmi";

type BaseState = ReturnType<typeof useWizPayState>;

const EMPTY_QUOTE_SUMMARY: QuoteSummary = {
  estimatedAmountsOut: [],
  totalEstimatedOut: 0n,
  totalFees: 0n,
};

const MAX_CONFIRMATION_POLLS = 20;
const POLL_INTERVAL_MS = 1500;
const ARC_MULTICALL3_ADDRESS =
  "0xca11bde05977b3631167028862be2a173976ca11" as Address;
const POST_SETTLEMENT_VERIFICATION_INITIAL_DELAY_MS = 750;
const POST_SETTLEMENT_VERIFICATION_RETRY_DELAY_MS = 750;
const POST_SETTLEMENT_VERIFICATION_MAX_ATTEMPTS = 4;

function requireWizPayAddress(): Address {
  if (!WIZPAY_ADDRESS) {
    throw new Error("WizPay is unavailable on the selected Arc network.");
  }
  return WIZPAY_ADDRESS;
}

type PostSettlementTokenState = {
  allowance: bigint;
  balance: bigint;
};

const postSettlementVerificationRequests = new Map<
  string,
  Promise<PostSettlementTokenState>
>();

type PreparedBatchRecipient = {
  address: Address;
  amountUnits: bigint;
  id: string;
  targetToken: TokenSymbol;
  validAddress: boolean;
};

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getRpcErrorText(error: unknown, depth = 0): string {
  if (depth > 4 || typeof error !== "object" || error === null) {
    return error instanceof Error ? error.message : String(error ?? "");
  }

  const parts = ["name", "message", "shortMessage", "details"]
    .map((key) => Reflect.get(error, key))
    .filter((value): value is string => typeof value === "string");
  const cause = Reflect.get(error, "cause");

  if (cause && cause !== error) {
    parts.push(getRpcErrorText(cause, depth + 1));
  }

  return parts.join(" ").toLowerCase();
}

function isTransientRpcError(error: unknown) {
  const errorText = getRpcErrorText(error);

  if (
    errorText.includes("execution reverted") ||
    errorText.includes("contract function execution error") ||
    errorText.includes("returned no data")
  ) {
    return false;
  }

  return [
    "429",
    "request limit",
    "rate limit",
    "too many requests",
    "temporarily unavailable",
    "rpc request failed",
    "http request failed",
    "fetch failed",
    "network error",
    "timed out",
    "timeout",
  ].some((fragment) => errorText.includes(fragment));
}

async function readPostSettlementTokenState({
  publicClient,
  tokenAddress,
  walletAddress,
  spenderAddress,
}: {
  publicClient: PublicClient;
  tokenAddress: Address;
  walletAddress: Address;
  spenderAddress: Address;
}): Promise<PostSettlementTokenState> {
  const requestKey = [
    publicClient.chain?.id ?? activeArcChain.id,
    tokenAddress.toLowerCase(),
    walletAddress.toLowerCase(),
    spenderAddress.toLowerCase(),
  ].join(":");
  const inFlightRequest = postSettlementVerificationRequests.get(requestKey);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const verificationRequest = (async () => {
    await waitFor(POST_SETTLEMENT_VERIFICATION_INITIAL_DELAY_MS);

    for (
      let attempt = 1;
      attempt <= POST_SETTLEMENT_VERIFICATION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const [allowance, balance] = await publicClient.multicall({
          allowFailure: false,
          contracts: [
            {
              address: tokenAddress,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [walletAddress, spenderAddress],
            },
            {
              address: tokenAddress,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [walletAddress],
            },
          ],
          multicallAddress: ARC_MULTICALL3_ADDRESS,
        });

        return { allowance, balance };
      } catch (error) {
        const canRetry =
          isTransientRpcError(error) &&
          attempt < POST_SETTLEMENT_VERIFICATION_MAX_ATTEMPTS;

        if (!canRetry) {
          throw error;
        }

        const retryDelay =
          POST_SETTLEMENT_VERIFICATION_RETRY_DELAY_MS * 2 ** (attempt - 1);
        logPayrollRouteDiagnostic(
          "[official-payroll-route] post-settlement verification retry",
          { attempt, nextAttempt: attempt + 1, retryDelay },
        );
        await waitFor(retryDelay);
      }
    }

    throw new Error("Post-settlement verification exhausted its retry window.");
  })();

  postSettlementVerificationRequests.set(requestKey, verificationRequest);

  try {
    return await verificationRequest;
  } finally {
    if (
      postSettlementVerificationRequests.get(requestKey) === verificationRequest
    ) {
      postSettlementVerificationRequests.delete(requestKey);
    }
  }
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
 * 3. Executes payroll batches client-side via external self-custodial wallets
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
  const { walletAddress } = useActiveWalletAddress();
  const { executeTransaction } = useTransactionExecutor();
  const publicClient = usePublicClient({ chainId: activeArcChain.id });

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
    chainId: activeArcChain.id,
    functionName: "allowance",
    args:
      walletAddress && allowanceSpender
        ? [walletAddress, allowanceSpender]
        : undefined,
    query: {
      enabled: Boolean(walletAddress && allowanceSpender),
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
    chainId: activeArcChain.id,
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
    chainId: activeArcChain.id,
    functionName: "feeBps",
    query: {
      enabled: Boolean(WIZPAY_ADDRESS),
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

  // ── Quote summary (Arc Mainnet-only: no on-chain quote read) ───
  // WizPayPayrollMainnet exposes no batch quote view; execution uses the
  // Mainnet atomic payroll route with local slippage floors instead.
  // The composer shows an empty quote until execution confirms on Arc.

  const quoteSummary = useMemo<QuoteSummary>(
    () => EMPTY_QUOTE_SUMMARY,
    [],
  );

  const feeBps = feeBpsData ?? 0n;

  // ── Loading / diagnostic states ─────────────────────────────────

  const allowanceLoading = Boolean(walletAddress) && allowanceQueryLoading;
  const balanceLoading = Boolean(walletAddress) && balanceQueryLoading;
  const feeLoading = feeQueryLoading;
  const engineLoading = false;
  const quoteLoading = false;
  const quoteRefreshing = false;

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
      const approvalReference = [
        "PAYROLL-APPROVAL",
        walletAddress.toLowerCase(),
        activeToken.address.toLowerCase(),
        requireWizPayAddress().toLowerCase(),
        amount.toString(),
      ].join(":");
      const approvalIntent = await acquireExecutionIntent({
        network: "arc-mainnet",
        operation: "TOKEN_APPROVAL",
        sourceWallet: walletAddress,
        recipient: requireWizPayAddress(),
        tokenIn: activeToken.address,
        tokenOut: activeToken.address,
        amountUnits: amount.toString(),
        externalReference: approvalReference,
      });
      const approvalResult = await executeTransaction({
        abi: ERC20_ABI,
        args: [requireWizPayAddress(), amount],
        chainId: activeArcChain.id,
        contractAddress: activeToken.address,
        functionName: "approve",
        executionIntentId: approvalIntent.id,
        idempotencyKey: approvalIntent.idempotencyKey,
        refId: approvalReference,
      });
      if (approvalResult.txHash && approvalResult.executionLeaseOwner) {
        await bindExecutionIntentTransactionHash(
          approvalIntent.id,
          approvalResult.txHash,
          approvalIntent.idempotencyKey,
          approvalResult.executionLeaseOwner,
        );
      }

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
    execution?: { intentId: string; idempotencyKey: string },
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

    const spenderAddress = requireWizPayAddress();

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

    // Determine the effective input token for the Mainnet payroll payout.
    // When all recipients target the same token AND it differs from activeToken,
    // it means a pre-swap has already been executed and the wallet now holds
    // the target token. Use the target token as input for same-token payout.
    const allSameTarget = batchPreparedRecipients.every(
      (r) => r.targetToken === batchPreparedRecipients[0].targetToken,
    );
    const batchTargetToken = batchPreparedRecipients[0]?.targetToken;
    const effectiveTokenIn =
      allSameTarget &&
      batchTargetToken &&
      batchTargetToken !== activeToken.symbol
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
      const verificationContext = {
        chainId: activeArcChain.id,
        methods: ["allowance", "balanceOf"],
        multicallAddress: ARC_MULTICALL3_ADDRESS,
        rpcEndpoint: ACTIVE_ARC_NETWORK.rpcUrl,
        spender: spenderAddress,
        token: effectiveTokenInSymbol,
        tokenAddress: effectiveTokenIn,
        walletAddress,
      };

      logPayrollRouteDiagnostic(
        "[official-payroll-route] post-settlement verification request",
        verificationContext,
      );

      try {
        const verifiedState = await readPostSettlementTokenState({
          publicClient,
          tokenAddress: effectiveTokenIn,
          walletAddress,
          spenderAddress,
        });
        latestAllowance = verifiedState.allowance;
        latestBalance = verifiedState.balance;
      } catch (verificationError) {
        const transientRpcFailure = isTransientRpcError(verificationError);
        logPayrollRouteDiagnostic(
          "[official-payroll-route] post-settlement verification failed",
          {
            ...verificationContext,
            error: verificationError,
            transientRpcFailure,
          },
        );

        if (!transientRpcFailure) {
          throw new Error(
            `Post-settlement ${effectiveTokenInSymbol} payroll verification failed: ${getFriendlyErrorMessage(verificationError)}`,
          );
        }

        throw new Error(
          `Arc Mainnet RPC could not verify the post-settlement ${effectiveTokenInSymbol} payroll allowance and balance. Wait a moment and use payroll recovery to continue.`,
        );
      }

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
            spender: requireWizPayAddress(),
          },
        );
        state.setStatusMessage(
          `Approving ${batchTargetToken} for payroll payout...`,
        );
        try {
          const approvalReference = [
            "PAYROLL-APPROVAL",
            walletAddress.toLowerCase(),
            effectiveTokenIn.toLowerCase(),
            requireWizPayAddress().toLowerCase(),
            batchTotalAmount.toString(),
          ].join(":");
          const approvalIntent = await acquireExecutionIntent({
            network: "arc-mainnet",
            operation: "TOKEN_APPROVAL",
            sourceWallet: walletAddress,
            recipient: requireWizPayAddress(),
            tokenIn: effectiveTokenIn,
            tokenOut: effectiveTokenIn,
            amountUnits: batchTotalAmount.toString(),
            externalReference: approvalReference,
          });
          const approvalResult = await executeTransaction({
            abi: ERC20_ABI,
            args: [requireWizPayAddress(), batchTotalAmount],
            chainId: activeArcChain.id,
            contractAddress: effectiveTokenIn,
            functionName: "approve",
            executionIntentId: approvalIntent.id,
            idempotencyKey: approvalIntent.idempotencyKey,
            refId: approvalReference,
          });
          if (approvalResult.txHash && approvalResult.executionLeaseOwner) {
            await bindExecutionIntentTransactionHash(
              approvalIntent.id,
              approvalResult.txHash,
              approvalIntent.idempotencyKey,
              approvalResult.executionLeaseOwner,
            );
          }
          if (!approvalResult.hash && !approvalResult.txHash) {
            const message = `Approval for ${batchTargetToken} was not confirmed.`;
            state.setErrorMessage(message);
            return { ok: false, hash: null, error: message };
          }
          // Only use txHash if it's a real EVM hash. The `hash` field may
          // contain a referenceId which must NOT be passed to RPC.
          const approvalEvmHash =
            approvalResult.txHash &&
            /^0x[a-fA-F0-9]{64}$/.test(approvalResult.txHash)
              ? approvalResult.txHash
              : approvalResult.hash &&
                  /^0x[a-fA-F0-9]{64}$/.test(approvalResult.hash)
                ? approvalResult.hash
                : null;

          logPayrollRouteDiagnostic(
            "[official-payroll-route] approval tx submitted",
            {
              token: batchTargetToken,
              txHash: approvalEvmHash,
              rawHash: approvalResult.hash,
              rawTxHash: approvalResult.txHash,
            },
          );

          if (approvalEvmHash) {
            state.setStatusMessage(
              `Waiting for ${batchTargetToken} approval confirmation on Arc...`,
            );
            await publicClient.waitForTransactionReceipt({
              hash: approvalEvmHash as Hex,
              confirmations: 1,
            });
          } else {
            // No EVM hash available — wait briefly then
            // rely on the allowance polling below to confirm the approval.
            state.setStatusMessage(
              `Confirming ${batchTargetToken} approval...`,
            );
            await waitFor(3000);
          }

          for (
            let attempt = 0;
            attempt < MAX_CONFIRMATION_POLLS;
            attempt += 1
          ) {
            const nextAllowance = (await publicClient.readContract({
              address: effectiveTokenIn,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [walletAddress, spenderAddress],
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

    if (ACTIVE_ARC_NETWORK.key === "arc-mainnet") {
      const payrollAddress = requireWizPayAddress();
      const recipients = batchPreparedRecipients.map(
        (recipient) => recipient.address,
      ) as Address[];
      const amounts = batchPreparedRecipients.map(
        (recipient) => recipient.amountUnits,
      );
      const tokenOuts = batchPreparedRecipients.map(
        (recipient) => SUPPORTED_TOKENS[recipient.targetToken].address,
      );
      const uniqueOut = new Set(tokenOuts.map((value) => value.toLowerCase()));
      if (uniqueOut.size !== 1) {
        const message =
          "Arc Mainnet payroll requires a homogeneous destination token group.";
        state.setErrorMessage(message);
        return { ok: false, hash: null, error: message };
      }
      const tokenOut = tokenOuts[0]!;
      const sameToken = tokenOut.toLowerCase() === activeToken.address.toLowerCase();
      const deadline = Math.floor(Date.now() / 1_000) + 10 * 60;
      state.setSubmitState("simulating");
      state.setSubmitTxHash(null);
      state.setErrorMessage(null);
      state.setStatusMessage(
        "Preparing the payroll batch for wallet confirmation...",
      );
      try {
        const functionName = sameToken
          ? "executeSameTokenPayroll"
          : "executeCrossTokenPayroll";
        const funding = sameToken
          ? sameTokenFunding(amounts, feeBps)
          : amounts.reduce((sum, amount) => sum + amount, 0n);
        const approval = payrollApprovalTarget({
          tokenIn: activeToken.address,
          tokenOut,
          funding,
        });
        if (approval && latestAllowance < approval.amount) {
          const message = `Approve ${activeToken.symbol} before submitting this payroll batch.`;
          state.setErrorMessage(message);
          return { ok: false, hash: null, error: message };
        }
        const args = sameToken
          ? [activeToken.address, recipients, amounts, referenceId]
          : [
              activeToken.address,
              tokenOut,
              recipients,
              amounts,
              funding,
              amounts.reduce((sum, amount) => sum + amount, 0n),
              calculateMinHopPriceX36(
                funding,
                amounts.reduce((sum, amount) => sum + amount, 0n),
                Number(PREVIEW_SLIPPAGE_BPS),
              ),
              BigInt(deadline),
              referenceId,
            ];
        const value = sameToken
          ? 0n
          : nativePayrollValue(activeToken.address, funding);
        state.setSubmitState("wallet");
        state.setStatusMessage("Confirm the payroll batch in your wallet.");
        const executionResult = await executeTransaction({
          abi: WIZPAY_PAYROLL_MAINNET_ABI,
          args,
          chainId: ACTIVE_ARC_NETWORK.chainId,
          contractAddress: payrollAddress,
          functionName,
          value,
          idempotencyKey: execution?.idempotencyKey,
          executionIntentId: execution?.intentId,
          refId: `PAYROLL-${referenceId}`,
        });
        if (
          execution?.intentId &&
          executionResult.txHash &&
          executionResult.executionLeaseOwner
        ) {
          await bindExecutionIntentTransactionHash(
            execution.intentId,
            executionResult.txHash,
            execution.idempotencyKey,
            executionResult.executionLeaseOwner,
          );
        }
        state.setSubmitState("confirming");
        state.setSubmitTxHash(executionResult.txHash ?? executionResult.hash);
        state.setStatusMessage("Waiting for Arc confirmation...");
        const confirmedHash = executionResult.txHash ?? executionResult.hash;
        state.setSubmitTxHash(confirmedHash);
        state.setSubmitState("confirmed");
        state.setStatusMessage(null);
        applyBatchSessionTotals(
          batchPreparedRecipients,
          batchTotalAmount,
          batchValidRecipientCount,
        );
        await Promise.all([refetchAllowance(), refetchBalance()]);
        return { ok: true, hash: confirmedHash };
      } catch (error) {
        const message = getFriendlyErrorMessage(error);
        state.setSubmitState("idle");
        state.setErrorMessage(message);
        state.setStatusMessage(null);
        return { ok: false, hash: null, error: message };
      }
    }

    // Arc Mainnet is the only execution path. Fail closed if the active
    // network ever stops resolving to arc-mainnet.
    const message =
      "Arc Mainnet payroll is unavailable on the selected network.";
    state.setErrorMessage(message);
    return { ok: false, hash: null, error: message };
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
    executionMeta: {
      providerLabel: "External Wallet",
      engineAddress: undefined,
    },
  };
}
