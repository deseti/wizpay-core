"use client";

import { useCallback, useRef, useState } from "react";
import { type Hex, formatUnits } from "viem";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import {
  APP_WALLET_SWAP_CHAIN,
  attachAppWalletSwapDepositTxHash,
  confirmAppWalletSwapDeposit,
  createAppWalletSwapOperation,
  executeAppWalletSwapOperation as executeOperationRequest,
  quoteAppWalletSwap,
  refundAppWalletSwapOperation,
  resolveAppWalletSwapDepositTxHash as resolveDepositTxHashRequest,
  submitAppWalletSwapDeposit as submitDepositRequest,
  type AppWalletSwapOperationResponse,
  type AppWalletSwapProvider,
  type AppWalletSwapQuoteResponse,
} from "@/lib/app-wallet-swap-service";
import { findFirstString } from "@/lib/user-swap-quote-parser";
import {
  SUPPORTED_TOKENS,
  getFriendlyErrorMessage,
  isTransactionHash,
  type TokenSymbol,
} from "@/lib/wizpay";

import {
  canExecuteAppWalletOperation,
  canRequestAppWalletRefund,
  getAppWalletOperationMessage,
  getAppWalletQuoteErrorMessage,
  getAppWalletQuoteProvider,
} from "./app-wallet-swap-view-model";
import { useAppWalletSwapPoller } from "./use-app-wallet-swap-poller";

export type SwapRequestStatus =
  | "idle"
  | "quoting"
  | "preparing"
  | "signing"
  | "creating"
  | "checkingAllowance"
  | "approving"
  | "depositing"
  | "confirming"
  | "resolving"
  | "executing"
  | "refunding"
  | "funding"
  | "settling";

interface AppWalletSwapRequestBase {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  fromAddress: string;
}

interface UseAppWalletSwapOperationOptions {
  appWalletSwapProvider: AppWalletSwapProvider | undefined;
  formInvalid: boolean;
  getRequestBase: () => AppWalletSwapRequestBase;
  isCircleWalletMode: boolean;
  modeBlockMessage: string | null;
  quote: AppWalletSwapQuoteResponse | null;
  quoteIsValid: boolean;
  quoteMatchesForm: boolean;
  setAppWalletSwapProvider: (
    provider: AppWalletSwapProvider | undefined,
  ) => void;
  setErrorMessage: (message: string | null) => void;
  setQuote: (quote: AppWalletSwapQuoteResponse | null) => void;
  setQuoteWalletMode: (mode: "circle" | "external" | null) => void;
  setRequestStatus: (status: SwapRequestStatus) => void;
  toast: typeof import("@/hooks/use-toast").toast;
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
      "data.id",
      "transactionId",
      "id",
    ]);

    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function getCircleReferenceId(...values: unknown[]) {
  for (const value of values) {
    const candidate = findFirstString(value, [
      "data.refId",
      "data.referenceId",
      "data.id",
      "refId",
      "referenceId",
      "challengeId",
      "id",
    ]);

    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function formatTokenUnits(value: string, token: TokenSymbol) {
  try {
    return formatUnits(BigInt(value), SUPPORTED_TOKENS[token].decimals);
  } catch {
    return value;
  }
}

export function useAppWalletSwapOperation({
  appWalletSwapProvider,
  formInvalid,
  getRequestBase,
  isCircleWalletMode,
  modeBlockMessage,
  quote,
  quoteIsValid,
  quoteMatchesForm,
  setAppWalletSwapProvider,
  setErrorMessage,
  setQuote,
  setQuoteWalletMode,
  setRequestStatus,
  toast,
}: UseAppWalletSwapOperationOptions) {
  const {
    arcWallet,
    createTransferChallenge,
    ensureSessionReady,
    executeChallenge,
    getWalletBalances,
  } = useCircleWallet();
  const [operation, setOperation] =
    useState<AppWalletSwapOperationResponse | null>(null);
  const [isOperationOpen, setIsOperationOpen] = useState(false);
  const [isRefundConfirmationOpen, setIsRefundConfirmationOpen] =
    useState(false);
  const autoProgressRef = useRef(false);
  const refundRequestInFlightRef = useRef(false);
  const { scheduleObservation } = useAppWalletSwapPoller();

  const requestQuote = useCallback(async () => {
    if (modeBlockMessage) {
      setErrorMessage(modeBlockMessage);
      return null;
    }

    if (formInvalid) {
      setErrorMessage("Connect a wallet and enter a valid swap amount first.");
      return null;
    }

    setRequestStatus("quoting");
    setErrorMessage(null);

    try {
      const nextQuote = await quoteAppWalletSwap({
        ...getRequestBase(),
        chain: APP_WALLET_SWAP_CHAIN,
        ...(appWalletSwapProvider ? { provider: appWalletSwapProvider } : {}),
      });
      setQuote(nextQuote);
      setQuoteWalletMode("circle");
      const resolvedProvider = getAppWalletQuoteProvider(nextQuote);
      if (resolvedProvider) {
        setAppWalletSwapProvider(resolvedProvider);
      }
      return nextQuote;
    } catch (error) {
      const { tokenIn, tokenOut } = getRequestBase();
      const message = getAppWalletQuoteErrorMessage(error, {
        tokenIn,
        tokenOut,
      });

      // Drop any previous quote so stale expected/minimum output cannot stay on
      // screen next to a failed quote. The entered amount and token direction
      // are deliberately left untouched so the user can just lower the amount.
      // The selected provider is never changed here.
      setQuote(null);
      setQuoteWalletMode(null);
      setErrorMessage(message);
      toast({
        title: "Quote unavailable",
        description: message,
        variant: "destructive",
      });
      return null;
    } finally {
      setRequestStatus("idle");
    }
  }, [
    appWalletSwapProvider,
    formInvalid,
    getRequestBase,
    modeBlockMessage,
    setAppWalletSwapProvider,
    setErrorMessage,
    setQuote,
    setQuoteWalletMode,
    setRequestStatus,
    toast,
  ]);

  const createDepositInstruction = useCallback(async () => {
    if (isCircleWalletMode && (!quoteMatchesForm || !quoteIsValid || !quote)) {
      setErrorMessage(
        "Wait for a current, valid App Wallet quote before confirming the swap.",
      );
      return;
    }

    const activeQuote =
      quoteMatchesForm && quoteIsValid ? quote : await requestQuote();

    if (!activeQuote) {
      return;
    }

    const operationProvider = getAppWalletQuoteProvider(activeQuote);
    if (!operationProvider) {
      throw new Error(
        "App Wallet quote did not include a supported execution provider.",
      );
    }

    setRequestStatus("creating");
    setErrorMessage(null);

    const nextOperation = await createAppWalletSwapOperation({
      ...getRequestBase(),
      chain: APP_WALLET_SWAP_CHAIN,
      provider: operationProvider,
    });

    setOperation(nextOperation);
    setIsOperationOpen(true);
    toast({
      title: "Ready to swap",
      description: `Approve the ${nextOperation.tokenIn} deposit to start your swap.`,
    });
  }, [
    getRequestBase,
    quote,
    quoteIsValid,
    quoteMatchesForm,
    requestQuote,
    setErrorMessage,
    setRequestStatus,
    toast,
  ]);

  const progressOperation = useCallback(
    async function progressOperation(
      initialOperation: AppWalletSwapOperationResponse,
    ) {
      if (autoProgressRef.current) return;
      autoProgressRef.current = true;

      try {
        let current = initialOperation;

        if (current.status === "deposit_submitted" && !current.depositTxHash) {
          for (let attempt = 0; attempt < 10; attempt++) {
            try {
              const resolved = await resolveDepositTxHashRequest(
                current.operationId,
              );
              current = resolved;
              setOperation(resolved);
              if (resolved.depositTxHash) break;
            } catch {
              // Preserve the existing best-effort resolution loop.
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }

        if (current.status === "deposit_submitted" && current.depositTxHash) {
          try {
            const confirmed = await confirmAppWalletSwapDeposit(
              current.operationId,
            );
            current = confirmed;
            setOperation(confirmed);
          } catch {
            // Preserve the existing retry-on-next-observation behavior.
          }
        }

        if (canExecuteAppWalletOperation(current)) {
          try {
            const executed = await executeOperationRequest(current.operationId);
            current = executed;
            setOperation(executed);

            if (executed.status === "completed") {
              if (arcWallet?.id) {
                void getWalletBalances(arcWallet.id).catch(() => null);
              }
              toast({
                title: "Swap completed",
                description: `${executed.tokenOut} is now in your App Wallet.`,
              });
              return;
            }
          } catch {
            // Preserve the existing retry-on-next-observation behavior.
          }
        }

        if (
          current.status !== "completed" &&
          current.status !== "execution_failed" &&
          current.status !== "execution_recovery_required" &&
          current.status !== "refunded"
        ) {
          scheduleObservation({
            operationId: current.operationId,
            onObserved: (polled) => {
              autoProgressRef.current = false;
              setOperation(polled);
              if (
                polled.status !== "completed" &&
                polled.status !== "execution_failed" &&
                polled.status !== "execution_recovery_required" &&
                polled.status !== "refunded"
              ) {
                void progressOperation(polled);
              } else if (polled.status === "completed") {
                if (arcWallet?.id) {
                  void getWalletBalances(arcWallet.id).catch(() => null);
                }
                toast({
                  title: "Swap completed",
                  description: `${polled.tokenOut} is now in your App Wallet.`,
                });
              }
            },
            onObservationError: () => {
              autoProgressRef.current = false;
              void progressOperation(current);
            },
          });
        }
      } finally {
        autoProgressRef.current = false;
      }
    },
    [arcWallet?.id, getWalletBalances, scheduleObservation, toast],
  );

  const submitDeposit = useCallback(async () => {
    if (!operation) {
      return;
    }

    if (operation.status !== "awaiting_user_deposit") {
      setErrorMessage("This operation is not awaiting a user deposit.");
      return;
    }

    if (!arcWallet?.id) {
      setErrorMessage("Circle App Wallet on Arc Testnet is not ready.");
      return;
    }

    setRequestStatus("depositing");
    setErrorMessage(null);

    try {
      await ensureSessionReady();

      const balances = await getWalletBalances(arcWallet.id);
      const tokenConfig = SUPPORTED_TOKENS[operation.tokenIn];
      const tokenBalance = balances.find((balance) => {
        const symbolMatches = balance.symbol === operation.tokenIn;
        const addressMatches =
          balance.tokenAddress?.toLowerCase() ===
          tokenConfig.address.toLowerCase();

        return symbolMatches || addressMatches;
      });

      if (!tokenBalance?.tokenId) {
        throw new Error(
          `${operation.tokenIn} token metadata is missing for App Wallet deposit.`,
        );
      }

      const depositAmount = formatTokenUnits(
        operation.amountIn,
        operation.tokenIn,
      );
      const transferChallenge = await createTransferChallenge({
        walletId: arcWallet.id,
        destinationAddress: operation.treasuryDepositAddress,
        tokenId: tokenBalance.tokenId,
        amounts: [depositAmount],
        feeLevel: "HIGH",
        refId: `APP-WALLET-SWAP-DEPOSIT-${operation.operationId}`,
      });
      let challengeResult: unknown;
      setIsOperationOpen(false);

      try {
        challengeResult = await executeChallenge(transferChallenge.challengeId);
      } finally {
        setIsOperationOpen(true);
      }

      const resolvedDepositTxHash = getCircleTxHash(
        challengeResult,
        transferChallenge.raw,
      );
      const circleTransactionId = getCircleTransactionId(
        challengeResult,
        transferChallenge.raw,
      );
      const circleReferenceId =
        getCircleReferenceId(challengeResult, transferChallenge.raw) ??
        transferChallenge.challengeId;

      const updatedOperation = await submitDepositRequest(
        operation.operationId,
        {
          ...(circleTransactionId ? { circleTransactionId } : {}),
          ...(circleReferenceId ? { circleReferenceId } : {}),
          circleWalletId: arcWallet.id,
        },
      );
      const operationWithTxHash = resolvedDepositTxHash
        ? await attachAppWalletSwapDepositTxHash(updatedOperation.operationId, {
            depositTxHash: resolvedDepositTxHash,
          })
        : updatedOperation;

      setOperation(operationWithTxHash);
      toast({
        title: "Deposit submitted",
        description: "Your swap is being processed.",
      });

      void progressOperation(operationWithTxHash);
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
      toast({
        title: "Deposit failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRequestStatus("idle");
    }
  }, [
    arcWallet?.id,
    createTransferChallenge,
    ensureSessionReady,
    executeChallenge,
    getWalletBalances,
    operation,
    progressOperation,
    setErrorMessage,
    setRequestStatus,
    toast,
  ]);

  const confirmDeposit = useCallback(async () => {
    if (!operation) return;
    if (operation.status !== "deposit_submitted") {
      setErrorMessage("This operation is not ready for deposit confirmation.");
      return;
    }
    if (!operation.depositTxHash) {
      const message =
        "Deposit submitted. Waiting for deposit txHash before on-chain verification.";
      setErrorMessage(message);
      toast({
        title: "Deposit txHash unavailable",
        description: message,
        variant: "destructive",
      });
      return;
    }

    setRequestStatus("confirming");
    setErrorMessage(null);
    try {
      const updatedOperation = await confirmAppWalletSwapDeposit(
        operation.operationId,
      );
      setOperation(updatedOperation);
      if (updatedOperation.status === "deposit_confirmed") {
        toast({
          title: "Deposit confirmed",
          description: `${updatedOperation.tokenIn} deposit is confirmed on-chain. Starting treasury swap and ${updatedOperation.tokenOut} payout.`,
        });
        setRequestStatus("executing");
        await executeOperation(updatedOperation);
        return;
      }
      const message =
        updatedOperation.depositConfirmationError ??
        "Deposit submitted by Circle reference, waiting for txHash/on-chain confirmation support.";
      setErrorMessage(message);
      toast({
        title: "Deposit not confirmed",
        description: message,
        variant: "destructive",
      });
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
      toast({
        title: "Deposit confirmation failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRequestStatus("idle");
    }
  }, [operation, setErrorMessage, setRequestStatus, toast]);

  const resolveDepositTxHash = useCallback(async () => {
    if (!operation) return;
    if (operation.status !== "deposit_submitted") {
      setErrorMessage("This operation is not ready for txHash resolution.");
      return;
    }

    setRequestStatus("resolving");
    setErrorMessage(null);
    try {
      const updatedOperation = await resolveDepositTxHashRequest(
        operation.operationId,
      );
      setOperation(updatedOperation);
      if (updatedOperation.depositTxHash) {
        toast({
          title: "Deposit txHash resolved",
          description: "You can now verify the deposit on-chain.",
        });
        return;
      }
      const message =
        updatedOperation.depositConfirmationError ??
        "Deposit txHash is not available from Circle yet. Retry shortly.";
      setErrorMessage(message);
      toast({
        title: "Deposit txHash unavailable",
        description: message,
        variant: "destructive",
      });
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
      toast({
        title: "Deposit txHash resolution failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRequestStatus("idle");
    }
  }, [operation, setErrorMessage, setRequestStatus, toast]);

  const executeOperation = useCallback(
    async (targetOperation: AppWalletSwapOperationResponse) => {
      const updatedOperation = await executeOperationRequest(
        targetOperation.operationId,
      );
      setOperation(updatedOperation);
      if (updatedOperation.status === "completed") {
        if (arcWallet?.id) {
          void getWalletBalances(arcWallet.id).catch(() => null);
        }
        toast({
          title: "Swap completed",
          description: `${updatedOperation.tokenOut} payout is confirmed in your App Wallet.`,
        });
        return;
      }
      if (updatedOperation.status === "execution_failed") {
        const message =
          updatedOperation.executionError ??
          "Treasury swap execution failed before completion.";
        setErrorMessage(message);
        toast({
          title: "Execution failed",
          description: message,
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Execution updated",
        description: getAppWalletOperationMessage(updatedOperation),
      });
    },
    [arcWallet?.id, getWalletBalances, setErrorMessage, toast],
  );

  const executeSwap = useCallback(async () => {
    if (!operation) return;
    if (!canExecuteAppWalletOperation(operation)) {
      setErrorMessage("This operation is not ready for settlement execution.");
      return;
    }
    setRequestStatus("executing");
    setErrorMessage(null);
    try {
      await executeOperation(operation);
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
      toast({
        title: "Execution failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRequestStatus("idle");
    }
  }, [executeOperation, operation, setErrorMessage, setRequestStatus, toast]);

  const requestRefund = useCallback(async () => {
    const currentOperation = operation;
    if (
      !isCircleWalletMode ||
      !currentOperation ||
      !canRequestAppWalletRefund(currentOperation)
    ) {
      setIsRefundConfirmationOpen(false);
      setErrorMessage(
        "This App Wallet operation is not eligible for refund recovery.",
      );
      return;
    }
    if (refundRequestInFlightRef.current) return;

    refundRequestInFlightRef.current = true;
    setIsRefundConfirmationOpen(false);
    setRequestStatus("refunding");
    setErrorMessage(null);
    try {
      const updatedOperation = await refundAppWalletSwapOperation(
        currentOperation.operationId,
      );
      setOperation(updatedOperation);
      if (updatedOperation.status === "refunded") {
        if (arcWallet?.id) {
          void getWalletBalances(arcWallet.id).catch(() => null);
        }
        toast({
          title: "Refund confirmed",
          description: `The verified ${updatedOperation.tokenIn} deposit refund is confirmed in your App Wallet.`,
        });
        return;
      }
      if (updatedOperation.executionError) {
        setErrorMessage(updatedOperation.executionError);
        toast({
          title: "Refund not available",
          description: updatedOperation.executionError,
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Refund updated",
        description: getAppWalletOperationMessage(updatedOperation),
      });
      if (
        updatedOperation.status === "refund_pending" ||
        updatedOperation.status === "refund_submitted"
      ) {
        void progressOperation(updatedOperation);
      }
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
      toast({
        title: "Refund request failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      refundRequestInFlightRef.current = false;
      setRequestStatus("idle");
    }
  }, [
    arcWallet?.id,
    getWalletBalances,
    isCircleWalletMode,
    operation,
    progressOperation,
    setErrorMessage,
    setRequestStatus,
    toast,
  ]);

  const reset = useCallback(() => {
    setOperation(null);
    setIsOperationOpen(false);
    setIsRefundConfirmationOpen(false);
  }, []);

  return {
    confirmDeposit,
    createDepositInstruction,
    executeSwap,
    isOperationOpen,
    isRefundConfirmationOpen,
    operation,
    requestQuote,
    requestRefund,
    reset,
    resolveDepositTxHash,
    setIsOperationOpen,
    setIsRefundConfirmationOpen,
    submitDeposit,
  };
}
