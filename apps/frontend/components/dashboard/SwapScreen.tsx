"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Hex, formatUnits } from "viem";
import {
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ERC20_ABI } from "@/constants/erc20";
import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useActionGuard } from "@/hooks/useActionGuard";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useDialogState } from "@/hooks/useDialogState";
import { useToast } from "@/hooks/use-toast";
import { buildXShareUrl } from "@/lib/social";
import {
  createArcSwapAdapter,
  executePreparedArcUserSwap,
} from "@/lib/circle-swap-kit";
import {
  APP_WALLET_SWAP_CHAIN,
  attachAppWalletSwapDepositTxHash,
  confirmAppWalletSwapDeposit,
  createAppWalletSwapOperation,
  executeAppWalletSwapOperation,
  getAppWalletSwapOperation,
  quoteAppWalletSwap,
  resolveAppWalletSwapDepositTxHash,
  submitAppWalletSwapDeposit,
  type AppWalletSwapOperationResponse,
  type AppWalletSwapQuoteResponse,
} from "@/lib/app-wallet-swap-service";
import {
  USER_SWAP_CHAIN,
  prepareUserSwap,
  quoteUserSwap,
  type UserSwapPrepareResponse,
  type UserSwapQuoteResponse,
} from "@/lib/user-swap-service";
import {
  findFirstString,
  formatUserSwapQuoteAmount,
  getUserSwapExpectedOutputDisplay,
  getUserSwapExpectedOutputValue,
  getUserSwapMinimumOutputDisplay,
} from "@/lib/user-swap-quote-parser";
import {
  EXPLORER_BASE_URL,
  PREVIEW_SLIPPAGE_BPS,
  SUPPORTED_TOKENS,
  formatTokenAmount,
  getFriendlyErrorMessage,
  isTransactionHash,
  parseAmountToUnits,
  type TokenSymbol,
} from "@/lib/wizpay";
import { arcTestnet } from "@/lib/wagmi";

type RequestStatus =
  | "idle"
  | "quoting"
  | "preparing"
  | "signing"
  | "creating"
  | "depositing"
  | "confirming"
  | "resolving"
  | "executing";
type SwapQuoteState = UserSwapQuoteResponse | AppWalletSwapQuoteResponse;

interface SwapSuccessState {
  amountIn: string;
  amountOut: string | null;
  explorerUrl: string | null;
  instructionCount: number;
  referenceId: string;
  status: "pending" | "success";
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  transactionId: string | null;
  transactionStatus: string | null;
  txHash: Hex | null;
  walletMode: "circle" | "external";
}

function shortenHash(hash: string | undefined) {
  if (!hash) {
    return "Pending";
  }

  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function getOperationExpectedOutput(operation: AppWalletSwapOperationResponse) {
  return getUserSwapExpectedOutputDisplay(
    {
      expectedOutput: operation.expectedOutput,
      rawQuote: operation.rawQuote,
    },
    operation.tokenOut,
  );
}

function getOperationMinimumOutput(operation: AppWalletSwapOperationResponse) {
  return getUserSwapMinimumOutputDisplay(
    {
      minimumOutput: operation.minimumOutput,
      rawQuote: operation.rawQuote,
    },
    operation.tokenOut,
  );
}

function isAppWalletExecutionStatus(
  status: AppWalletSwapOperationResponse["status"],
) {
  return [
    "treasury_swap_pending",
    "treasury_swap_submitted",
    "treasury_swap_confirmed",
    "payout_pending",
    "payout_submitted",
    "payout_confirmed",
  ].includes(status);
}

function canExecuteAppWalletOperation(
  operation: AppWalletSwapOperationResponse,
) {
  return (
    operation.status === "deposit_confirmed" ||
    operation.status === "execution_failed" ||
    isAppWalletExecutionStatus(operation.status)
  );
}

function getAppWalletOperationMessage(
  operation: AppWalletSwapOperationResponse,
) {
  switch (operation.status) {
    case "deposit_confirmed":
    case "treasury_swap_pending":
    case "treasury_swap_submitted":
    case "treasury_swap_confirmed":
    case "payout_pending":
      return "WizPay is securely settling your swap. This can take a few minutes.";
    case "payout_submitted":
    case "payout_confirmed":
      return "Your output token is being sent back to your App Wallet.";
    case "completed":
      return `Swap completed. ${operation.tokenOut} is in your App Wallet.`;
    case "execution_failed":
      return "Something went wrong during settlement. You can retry the status check.";
    case "deposit_submitted":
      return "Deposit received. Waiting for network confirmation.";
    default:
      return "Approve the deposit from your App Wallet to start the swap.";
  }
}

type AppWalletSwapPhase =
  | "confirm_deposit"
  | "processing_swap"
  | "receiving_payout"
  | "completed"
  | "failed";

function getAppWalletSwapPhase(
  operation: AppWalletSwapOperationResponse | null,
): AppWalletSwapPhase {
  if (!operation) return "confirm_deposit";
  switch (operation.status) {
    case "awaiting_user_deposit":
      return "confirm_deposit";
    case "deposit_submitted":
    case "deposit_confirmed":
    case "treasury_swap_pending":
    case "treasury_swap_submitted":
    case "treasury_swap_confirmed":
    case "payout_pending":
      return "processing_swap";
    case "payout_submitted":
    case "payout_confirmed":
      return "receiving_payout";
    case "completed":
      return "completed";
    case "execution_failed":
      return "failed";
    default:
      return "confirm_deposit";
  }
}

function getPhaseTitle(phase: AppWalletSwapPhase): string {
  switch (phase) {
    case "confirm_deposit":
      return "Confirm swap";
    case "processing_swap":
      return "Processing your swap";
    case "receiving_payout":
      return "Sending funds to your wallet";
    case "completed":
      return "Swap completed";
    case "failed":
      return "Swap needs attention";
  }
}

function getPhaseDescription(
  phase: AppWalletSwapPhase,
  operation: AppWalletSwapOperationResponse | null,
): string {
  switch (phase) {
    case "confirm_deposit":
      return "Approve the deposit from your App Wallet to start the swap.";
    case "processing_swap":
      return "WizPay is securely settling your swap. This can take a few minutes.";
    case "receiving_payout":
      return "Your output token is being sent back to your App Wallet.";
    case "completed":
      return operation
        ? `You received ${formatUserSwapQuoteAmount(operation.payoutAmount ?? operation.treasurySwapActualOutput, operation.tokenOut) ?? operation.tokenOut} in your App Wallet.`
        : "Swap is complete.";
    case "failed":
      return "Something went wrong during settlement. You can retry the status check.";
  }
}

function isTerminalFailure(operation: AppWalletSwapOperationResponse): boolean {
  return (
    operation.status === "execution_failed" &&
    Boolean(operation.executionError)
  );
}

function ProgressStep({ label, status }: { label: string; status: "pending" | "active" | "done" }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
        status === "done"
          ? "bg-emerald-500/20 text-emerald-400"
          : status === "active"
            ? "bg-sky-500/20 text-sky-300"
            : "bg-muted/20 text-muted-foreground/40"
      }`}>
        {status === "done" ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : status === "active" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <div className="h-1.5 w-1.5 rounded-full bg-current" />
        )}
      </div>
      <span className={
        status === "done"
          ? "text-emerald-400"
          : status === "active"
            ? "text-foreground font-medium"
            : "text-muted-foreground/50"
      }>
        {label}
      </span>
    </div>
  );
}

function DetailRow({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted-foreground/60">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 break-all text-right text-foreground/80">{value}</span>
        {onCopy && (
          <button type="button" onClick={onCopy} className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground/70">
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
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

function getPreparedAmountOut(
  prepared: UserSwapPrepareResponse,
  tokenOut: TokenSymbol,
) {
  return formatUserSwapQuoteAmount(
    getUserSwapExpectedOutputValue(prepared),
    tokenOut,
  );
}

export function SwapScreen() {
  const { walletAddress, walletMode } = useActiveWalletAddress();
  const {
    arcWallet,
    createTransferChallenge,
    ensureSessionReady,
    executeChallenge,
    getWalletBalances,
  } = useCircleWallet();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { toast } = useToast();
  const { isProcessing: isGuarded, guard } = useActionGuard();
  const { isOpen: isSuccessDialogOpen, setIsOpen: setIsSuccessDialogOpen } =
    useDialogState();

  const [tokenIn, setTokenIn] = useState<TokenSymbol>("USDC");
  const [tokenOut, setTokenOut] = useState<TokenSymbol>("EURC");
  const [amountIn, setAmountIn] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [quote, setQuote] = useState<SwapQuoteState | null>(null);
  const [appWalletOperation, setAppWalletOperation] =
    useState<AppWalletSwapOperationResponse | null>(null);
  const [isAppWalletOperationOpen, setIsAppWalletOperationOpen] =
    useState(false);
  const [successState, setSuccessState] = useState<SwapSuccessState | null>(
    null,
  );
  const [advancedDetailsOpen, setAdvancedDetailsOpen] = useState(false);
  const autoProgressRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokenInConfig = SUPPORTED_TOKENS[tokenIn];
  const amountInUnits = useMemo(
    () => parseAmountToUnits(amountIn, tokenInConfig.decimals),
    [amountIn, tokenInConfig.decimals],
  );
  const amountInBaseUnits = amountInUnits.toString();
  const { data: currentBalanceData } = useReadContract({
    address: tokenInConfig.address,
    abi: ERC20_ABI,
    chainId: arcTestnet.id,
    functionName: "balanceOf",
    args: walletAddress ? [walletAddress] : undefined,
    query: { enabled: Boolean(walletAddress && walletMode === "external") },
  });
  const currentBalance = currentBalanceData ?? 0n;
  const insufficientBalance = amountInUnits > currentBalance;
  const isExternalWalletMode = walletMode === "external";
  const isCircleWalletMode = walletMode === "circle";
  const isExternalWalletOnArc = walletClient?.chain?.id === arcTestnet.id;
  const swapAdapter = useMemo(
    () =>
      isExternalWalletMode
        ? createArcSwapAdapter(publicClient, walletClient)
        : null,
    [isExternalWalletMode, publicClient, walletClient],
  );
  const modeBlockMessage = isCircleWalletMode
    ? null
    : !isExternalWalletMode
      ? "Select an external wallet or Circle App Wallet before starting an Arc Testnet swap."
      : !walletClient
        ? "Connect an external EVM wallet before starting an Arc Testnet swap."
        : !isExternalWalletOnArc
          ? "Switch your external wallet to Arc Testnet before quoting or swapping."
          : !publicClient
            ? "Arc Testnet public client is not ready yet."
            : null;
  const formInvalid =
    !walletAddress || tokenIn === tokenOut || amountInUnits <= 0n;
  const quoteMatchesForm =
    quote !== null &&
    quote.tokenIn === tokenIn &&
    quote.tokenOut === tokenOut &&
    quote.amountIn === amountInBaseUnits &&
    (!("fromAddress" in quote) ||
      quote.fromAddress.toLowerCase() === walletAddress?.toLowerCase());
  const expectedOutput = quoteMatchesForm
    ? getUserSwapExpectedOutputDisplay(quote, tokenOut)
    : null;
  const minimumOutput = quoteMatchesForm
    ? getUserSwapMinimumOutputDisplay(quote, tokenOut)
    : null;
  const busy = requestStatus !== "idle" || isGuarded;
  const quoteDisabled =
    busy ||
    formInvalid ||
    (isExternalWalletMode && insufficientBalance) ||
    Boolean(modeBlockMessage);
  const swapDisabled =
    quoteDisabled || (isCircleWalletMode && !quoteMatchesForm && requestStatus !== "idle");

  function resetSwapFeedback() {
    setErrorMessage(null);
    setSuccessState(null);
    setAppWalletOperation(null);
    setIsAppWalletOperationOpen(false);
    setQuote(null);
  }

  function getRequestBase() {
    if (!walletAddress) {
      throw new Error("Connect a wallet before starting a swap.");
    }

    return {
      tokenIn,
      tokenOut,
      amountIn: amountInBaseUnits,
      fromAddress: walletAddress,
      chain: USER_SWAP_CHAIN,
    } as const;
  }

  async function requestQuote() {
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
      const nextQuote = isCircleWalletMode
        ? await quoteAppWalletSwap({
            ...getRequestBase(),
            chain: APP_WALLET_SWAP_CHAIN,
          })
        : await quoteUserSwap(getRequestBase());
      setQuote(nextQuote);
      return nextQuote;
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
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
  }

  async function copyToClipboard(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: "Copied",
        description: `${label} copied to clipboard.`,
      });
    } catch {
      toast({
        title: "Copy failed",
        description: `Could not copy ${label}.`,
        variant: "destructive",
      });
    }
  }

  async function createAppWalletDepositInstruction() {
    const activeQuote = quoteMatchesForm ? quote : await requestQuote();

    if (!activeQuote) {
      return;
    }

    setRequestStatus("creating");
    setErrorMessage(null);

    const operation = await createAppWalletSwapOperation({
      ...getRequestBase(),
      chain: APP_WALLET_SWAP_CHAIN,
    });

    setAppWalletOperation(operation);
    setIsAppWalletOperationOpen(true);
    toast({
      title: "Ready to swap",
      description: `Approve the ${operation.tokenIn} deposit to start your swap.`,
    });
  }

  async function submitAppWalletDeposit() {
    if (!appWalletOperation) {
      return;
    }

    if (appWalletOperation.status !== "awaiting_user_deposit") {
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
      const tokenConfig = SUPPORTED_TOKENS[appWalletOperation.tokenIn];
      const tokenBalance = balances.find((balance) => {
        const symbolMatches = balance.symbol === appWalletOperation.tokenIn;
        const addressMatches =
          balance.tokenAddress?.toLowerCase() ===
          tokenConfig.address.toLowerCase();

        return symbolMatches || addressMatches;
      });

      if (!tokenBalance?.tokenId) {
        throw new Error(
          `${appWalletOperation.tokenIn} token metadata is missing for App Wallet deposit.`,
        );
      }

      const depositAmount = formatTokenUnits(
        appWalletOperation.amountIn,
        appWalletOperation.tokenIn,
      );
      const transferChallenge = await createTransferChallenge({
        walletId: arcWallet.id,
        destinationAddress: appWalletOperation.treasuryDepositAddress,
        tokenId: tokenBalance.tokenId,
        amounts: [depositAmount],
        feeLevel: "HIGH",
        refId: `APP-WALLET-SWAP-DEPOSIT-${appWalletOperation.operationId}`,
      });
      let challengeResult: unknown;
      setIsAppWalletOperationOpen(false);

      try {
        challengeResult = await executeChallenge(transferChallenge.challengeId);
      } finally {
        setIsAppWalletOperationOpen(true);
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

      const updatedOperation = await submitAppWalletSwapDeposit(
        appWalletOperation.operationId,
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

      setAppWalletOperation(operationWithTxHash);
      toast({
        title: "Deposit submitted",
        description: "Your swap is being processed.",
      });

      // Auto-progress after deposit
      void progressAppWalletOperation(operationWithTxHash);
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
  }

  async function confirmAppWalletDeposit() {
    if (!appWalletOperation) {
      return;
    }

    if (appWalletOperation.status !== "deposit_submitted") {
      setErrorMessage("This operation is not ready for deposit confirmation.");
      return;
    }

    if (!appWalletOperation.depositTxHash) {
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
        appWalletOperation.operationId,
      );

      setAppWalletOperation(updatedOperation);

      if (updatedOperation.status === "deposit_confirmed") {
        toast({
          title: "Deposit confirmed",
          description: `${updatedOperation.tokenIn} deposit is confirmed on-chain. Starting treasury swap and ${updatedOperation.tokenOut} payout.`,
        });
        setRequestStatus("executing");
        await executeAppWalletOperation(updatedOperation);
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
  }

  async function resolveAppWalletDepositTxHash() {
    if (!appWalletOperation) {
      return;
    }

    if (appWalletOperation.status !== "deposit_submitted") {
      setErrorMessage("This operation is not ready for txHash resolution.");
      return;
    }

    setRequestStatus("resolving");
    setErrorMessage(null);

    try {
      const updatedOperation = await resolveAppWalletSwapDepositTxHash(
        appWalletOperation.operationId,
      );

      setAppWalletOperation(updatedOperation);

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
  }

  async function executeAppWalletOperation(
    operation: AppWalletSwapOperationResponse,
  ) {
    const updatedOperation = await executeAppWalletSwapOperation(
      operation.operationId,
    );

    setAppWalletOperation(updatedOperation);

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
  }

  async function executeAppWalletSwap() {
    if (!appWalletOperation) {
      return;
    }

    if (!canExecuteAppWalletOperation(appWalletOperation)) {
      setErrorMessage("This operation is not ready for settlement execution.");
      return;
    }

    setRequestStatus("executing");
    setErrorMessage(null);

    try {
      await executeAppWalletOperation(appWalletOperation);
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
  }

  const progressAppWalletOperation = useCallback(
    async (operation: AppWalletSwapOperationResponse) => {
      if (autoProgressRef.current) return;
      autoProgressRef.current = true;

      try {
        let current = operation;

        // Phase 1: If deposit_submitted without txHash, try to resolve it
        if (
          current.status === "deposit_submitted" &&
          !current.depositTxHash
        ) {
          for (let attempt = 0; attempt < 10; attempt++) {
            try {
              const resolved = await resolveAppWalletSwapDepositTxHash(
                current.operationId,
              );
              current = resolved;
              setAppWalletOperation(resolved);
              if (resolved.depositTxHash) break;
            } catch {
              // Ignore resolve errors during auto-progression
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
        }

        // Phase 2: If deposit_submitted with txHash, confirm it
        if (
          current.status === "deposit_submitted" &&
          current.depositTxHash
        ) {
          try {
            const confirmed = await confirmAppWalletSwapDeposit(
              current.operationId,
            );
            current = confirmed;
            setAppWalletOperation(confirmed);
          } catch {
            // Will retry on next poll
          }
        }

        // Phase 3: If deposit_confirmed or execution states, execute
        if (canExecuteAppWalletOperation(current)) {
          try {
            const executed = await executeAppWalletSwapOperation(
              current.operationId,
            );
            current = executed;
            setAppWalletOperation(executed);

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
            // Will retry on next poll
          }
        }

        // Phase 4: If not completed, poll for status updates
        if (
          current.status !== "completed" &&
          current.status !== "execution_failed"
        ) {
          pollTimerRef.current = setTimeout(async () => {
            autoProgressRef.current = false;
            try {
              const polled = await getAppWalletSwapOperation(
                current.operationId,
              );
              setAppWalletOperation(polled);
              if (
                polled.status !== "completed" &&
                polled.status !== "execution_failed"
              ) {
                void progressAppWalletOperation(polled);
              } else if (polled.status === "completed") {
                if (arcWallet?.id) {
                  void getWalletBalances(arcWallet.id).catch(() => null);
                }
                toast({
                  title: "Swap completed",
                  description: `${polled.tokenOut} is now in your App Wallet.`,
                });
              }
            } catch {
              // Silently retry
              autoProgressRef.current = false;
            }
          }, 5000);
        }
      } finally {
        autoProgressRef.current = false;
      }
    },
    [arcWallet?.id, getWalletBalances, toast],
  );

  // Cleanup poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  async function handleSwap() {
    if (modeBlockMessage) {
      setErrorMessage(modeBlockMessage);
      return;
    }

    if (isExternalWalletMode && !walletClient) {
      setErrorMessage("Connect an external EVM wallet before swapping.");
      return;
    }

    if (formInvalid) {
      setErrorMessage("Connect a wallet and enter a valid swap amount first.");
      return;
    }

    if (isExternalWalletMode && insufficientBalance) {
      setErrorMessage(`Insufficient ${tokenIn} balance.`);
      return;
    }

    setErrorMessage(null);

    try {
      if (!quoteMatchesForm) {
        const activeQuote = await requestQuote();

        if (!activeQuote) {
          return;
        }
      }

      setRequestStatus("preparing");

      if (isCircleWalletMode) {
        await createAppWalletDepositInstruction();
        return;
      }

      const prepared = await prepareUserSwap({
        ...getRequestBase(),
        slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
      });

      setRequestStatus("signing");

      if (!swapAdapter) {
        throw new Error("Swap adapter is not ready for the connected external wallet.");
      }

      const txHash = await executePreparedArcUserSwap({
        adapter: swapAdapter,
        prepared,
        tokenIn,
      });

      if (!isTransactionHash(txHash)) {
        throw new Error("Wallet returned an invalid transaction hash.");
      }

      setSuccessState({
        amountIn,
        amountOut: getPreparedAmountOut(prepared, tokenOut),
        explorerUrl: `${EXPLORER_BASE_URL}/tx/${txHash}`,
        instructionCount: 1,
        referenceId: txHash,
        status: "success",
        tokenIn,
        tokenOut,
        transactionId: txHash,
        transactionStatus: "COMPLETE",
        txHash,
        walletMode: "external",
      });
      setIsSuccessDialogOpen(true);
      toast({
        title: "Swap submitted",
        description: `External wallet submitted ${shortenHash(txHash)} on Arc Testnet.`,
      });
    } catch (error) {
      const message = getFriendlyErrorMessage(error);
      setErrorMessage(message);
      toast({
        title: "Swap failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRequestStatus("idle");
    }
  }

  return (
    <>
      <div className="animate-fade-up space-y-4 sm:space-y-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Swap
          </h1>
          <p className="text-sm text-muted-foreground/70">
            {isCircleWalletMode
              ? "Swap tokens using your App Wallet on Arc Testnet."
              : "External wallet Arc Testnet swap. Signed by connected external wallet."}
          </p>
        </div>

        <Card className="glass-card mx-auto max-w-lg overflow-hidden border-border/40">
          <CardContent className="space-y-4 py-5 sm:space-y-5 sm:py-6">
            <div className="space-y-3 rounded-2xl border border-border/40 bg-background/35 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  You pay
                </span>
                <span className="text-xs text-muted-foreground/50">
                  {isExternalWalletMode
                    ? `Balance: ${formatTokenAmount(currentBalance, tokenInConfig.decimals)} ${tokenIn}`
                    : "App Wallet swap"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.000001"
                  placeholder="0.0"
                  value={amountIn}
                  onChange={(event) => {
                    resetSwapFeedback();
                    setAmountIn(event.target.value);
                  }}
                  className="h-12 flex-1 border-0 bg-transparent p-0 text-2xl font-bold placeholder:text-muted-foreground/30 focus-visible:ring-0"
                />
                <Select
                  value={tokenIn}
                  onValueChange={(value) => {
                    const nextTokenIn = value as TokenSymbol;

                    resetSwapFeedback();
                    setTokenIn(nextTokenIn);

                    if (nextTokenIn === tokenOut) {
                      setTokenOut(nextTokenIn === "USDC" ? "EURC" : "USDC");
                    }
                  }}
                >
                  <SelectTrigger className="h-10 w-[110px] rounded-xl border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(SUPPORTED_TOKENS).map((token) => (
                      <SelectItem
                        key={`in-${token.symbol}`}
                        value={token.symbol}
                      >
                        {token.symbol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="relative z-10 -my-2 flex justify-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/40 bg-card/80 text-primary shadow-lg">
                <ArrowRightLeft className="h-4 w-4 rotate-90" />
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-border/40 bg-background/35 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  You receive
                </span>
                <span className="text-xs text-muted-foreground/50">
                  Backend proxy quote
                </span>
              </div>
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 text-2xl font-bold">
                  {expectedOutput ?? "0.0"}
                </p>
                <Select
                  value={tokenOut}
                  onValueChange={(value) => {
                    resetSwapFeedback();
                    setTokenOut(value as TokenSymbol);
                  }}
                >
                  <SelectTrigger className="h-10 w-[110px] rounded-xl border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(SUPPORTED_TOKENS)
                      .filter((token) => token.symbol !== tokenIn)
                      .map((token) => (
                        <SelectItem
                          key={`out-${token.symbol}`}
                          value={token.symbol}
                        >
                          {token.symbol}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-border/30 bg-background/20 px-4 py-3 text-sm">
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Network</span>
                <span className="font-mono text-foreground">Arc Testnet</span>
              </div>
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Expected output</span>
                <span className="font-mono text-foreground">
                  {expectedOutput ?? "-"}
                </span>
              </div>
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Minimum output</span>
                <span className="font-mono text-foreground">
                  {minimumOutput ?? "-"}
                </span>
              </div>
              <div className="flex justify-between gap-3 text-muted-foreground/70">
                <span>Slippage</span>
                <span className="font-mono text-foreground">2%</span>
              </div>
            </div>

            {modeBlockMessage ? (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
                {modeBlockMessage}
              </div>
            ) : null}

            {isCircleWalletMode ? (
              <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
                App Wallet swap settles securely through WizPay. Approve the
                deposit and your swap will complete automatically.
              </div>
            ) : null}

            {errorMessage && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <span>{errorMessage}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setErrorMessage(null)}
                  className="shrink-0 text-destructive hover:text-destructive/80"
                >
                  Dismiss
                </Button>
              </div>
            )}

            {isExternalWalletMode && insufficientBalance && amountInUnits > 0n && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
                Insufficient {tokenIn} balance.
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                variant="outline"
                onClick={() => void requestQuote()}
                disabled={quoteDisabled}
                className="h-12 text-base"
              >
                {requestStatus === "quoting" ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Quoting...
                  </span>
                ) : (
                  "Preview quote"
                )}
              </Button>
              <Button
                onClick={() => void guard(handleSwap)}
                disabled={swapDisabled}
                className="glow-btn h-12 bg-gradient-to-r from-primary to-violet-500 text-base text-primary-foreground shadow-lg shadow-primary/20"
              >
                {requestStatus === "preparing" ||
                requestStatus === "signing" ||
                requestStatus === "creating" ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {requestStatus === "creating"
                      ? "Preparing..."
                      : requestStatus === "signing"
                      ? isCircleWalletMode
                        ? "Waiting for confirmation..."
                        : "Signing..."
                      : "Preparing..."}
                  </span>
                ) : (
                  <>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    {isCircleWalletMode
                      ? "Confirm swap"
                      : "Swap"}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Token Pair
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground/80">
            <p>
              Only Arc Testnet USDC and EURC are enabled. External wallets
              sign directly via the connected browser wallet. App Wallet swaps
              are settled securely by WizPay after you approve the deposit.
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={isAppWalletOperationOpen}
        onOpenChange={setIsAppWalletOperationOpen}
      >
        <DialogContent className="glass-card max-w-lg overflow-hidden border-border/40 bg-background/95 p-0">
          <div className="relative overflow-hidden p-6">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-400/40 to-transparent" />

            {appWalletOperation ? (() => {
              const phase = getAppWalletSwapPhase(appWalletOperation);
              const phaseTitle = getPhaseTitle(phase);
              const phaseDescription = getPhaseDescription(phase, appWalletOperation);
              const isInProgress = phase === "processing_swap" || phase === "receiving_payout";
              const isComplete = phase === "completed";
              const isFailed = phase === "failed";

              return (
                <div className="space-y-5">
                  {/* Phase icon */}
                  <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ${
                    isComplete
                      ? "bg-emerald-500/12 text-emerald-400 ring-emerald-400/20"
                      : isFailed
                        ? "bg-red-500/12 text-red-400 ring-red-400/20"
                        : "bg-sky-500/12 text-sky-300 ring-sky-400/20"
                  }`}>
                    {isComplete ? (
                      <CheckCircle2 className="h-7 w-7" />
                    ) : isInProgress ? (
                      <Loader2 className="h-7 w-7 animate-spin" />
                    ) : (
                      <Clock3 className="h-7 w-7" />
                    )}
                  </div>

                  {/* Phase header */}
                  <DialogHeader className="space-y-2">
                    <DialogTitle className="text-xl">{phaseTitle}</DialogTitle>
                    <DialogDescription>{phaseDescription}</DialogDescription>
                  </DialogHeader>

                  {/* Progress steps */}
                  <div className="space-y-2">
                    <ProgressStep
                      label="Confirm deposit"
                      status={
                        phase === "confirm_deposit"
                          ? "active"
                          : "done"
                      }
                    />
                    <ProgressStep
                      label="Processing swap"
                      status={
                        phase === "processing_swap"
                          ? "active"
                          : phase === "confirm_deposit"
                            ? "pending"
                            : "done"
                      }
                    />
                    <ProgressStep
                      label="Sending funds to your wallet"
                      status={
                        phase === "receiving_payout"
                          ? "active"
                          : phase === "completed"
                            ? "done"
                            : "pending"
                      }
                    />
                    <ProgressStep
                      label="Completed"
                      status={phase === "completed" ? "done" : "pending"}
                    />
                  </div>

                  {/* Swap summary */}
                  <div className="rounded-xl border border-border/40 bg-background/45 p-4 space-y-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground/70">Swap</span>
                      <span className="font-medium">
                        {formatUserSwapQuoteAmount(appWalletOperation.amountIn, appWalletOperation.tokenIn) ?? `${appWalletOperation.amountIn} ${appWalletOperation.tokenIn}`}
                        {" → "}
                        {appWalletOperation.tokenOut}
                      </span>
                    </div>
                    {(appWalletOperation.payoutAmount || appWalletOperation.treasurySwapActualOutput) && (
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground/70">Received</span>
                        <span className="font-mono font-medium text-emerald-400">
                          {formatUserSwapQuoteAmount(
                            appWalletOperation.payoutAmount ?? appWalletOperation.treasurySwapActualOutput,
                            appWalletOperation.tokenOut,
                          )}
                        </span>
                      </div>
                    )}
                    {!appWalletOperation.payoutAmount && !appWalletOperation.treasurySwapActualOutput && getOperationExpectedOutput(appWalletOperation) && (
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground/70">Expected</span>
                        <span className="font-mono font-medium">
                          {getOperationExpectedOutput(appWalletOperation)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Error display — only for true failures */}
                  {isFailed && appWalletOperation.executionError && (
                    <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-4 py-3 text-sm text-red-200">
                      {appWalletOperation.executionError}
                    </div>
                  )}

                  {/* Pending status messages — not errors */}
                  {isInProgress && (
                    <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
                      {appWalletOperation.status === "deposit_submitted" && !appWalletOperation.depositTxHash
                        ? "Deposit received. Waiting for network confirmation."
                        : appWalletOperation.status === "payout_pending" || appWalletOperation.status === "treasury_swap_confirmed"
                          ? "Final wallet transfer is being confirmed."
                          : "WizPay is securely settling your swap. This can take a few minutes."}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex flex-col gap-3 sm:flex-row">
                    {phase === "confirm_deposit" && (
                      <Button
                        className="flex-1 glow-btn bg-gradient-to-r from-primary to-violet-500 text-primary-foreground"
                        onClick={() => void guard(submitAppWalletDeposit)}
                        disabled={requestStatus === "depositing"}
                      >
                        {requestStatus === "depositing" ? (
                          <span className="flex items-center gap-2">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            Waiting for confirmation...
                          </span>
                        ) : (
                          "Confirm swap"
                        )}
                      </Button>
                    )}
                    {isInProgress && (
                      <Button
                        className="flex-1"
                        disabled
                      >
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Processing swap...
                        </span>
                      </Button>
                    )}
                    {phase === "receiving_payout" && (
                      <Button className="flex-1" disabled>
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Sending funds to your wallet...
                        </span>
                      </Button>
                    )}
                    {isComplete && (
                      <Button
                        className="flex-1"
                        onClick={() => {
                          setIsAppWalletOperationOpen(false);
                          resetSwapFeedback();
                        }}
                      >
                        Done
                      </Button>
                    )}
                    {isFailed && (
                      <Button
                        className="flex-1"
                        onClick={() => void guard(executeAppWalletSwap)}
                        disabled={requestStatus === "executing"}
                      >
                        {requestStatus === "executing" ? (
                          <span className="flex items-center gap-2">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            Retrying...
                          </span>
                        ) : (
                          "Retry status check"
                        )}
                      </Button>
                    )}
                    {appWalletOperation.payoutTxHash && (
                      <Button asChild variant="outline" className="flex-1">
                        <a
                          href={`${EXPLORER_BASE_URL}/tx/${appWalletOperation.payoutTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink className="h-4 w-4" />
                          View transaction
                        </a>
                      </Button>
                    )}
                    {!isComplete && !isFailed && phase !== "confirm_deposit" ? null : (
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => setIsAppWalletOperationOpen(false)}
                      >
                        Close
                      </Button>
                    )}
                  </div>

                  {/* Advanced details — collapsible */}
                  <div className="border-t border-border/30 pt-3">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-xs text-muted-foreground/60 hover:text-muted-foreground/80 transition-colors"
                      onClick={() => setAdvancedDetailsOpen(!advancedDetailsOpen)}
                    >
                      {advancedDetailsOpen ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      Advanced details
                    </button>
                    {advancedDetailsOpen && (
                      <div className="mt-3 space-y-2 rounded-xl border border-border/30 bg-background/30 p-3 text-xs font-mono">
                        <DetailRow label="Operation ID" value={appWalletOperation.operationId} onCopy={() => void copyToClipboard(appWalletOperation.operationId, "operation ID")} />
                        <DetailRow label="Internal status" value={appWalletOperation.status} />
                        {appWalletOperation.depositTxHash && (
                          <DetailRow label="Deposit txHash" value={appWalletOperation.depositTxHash} />
                        )}
                        {appWalletOperation.treasurySwapTxHash && (
                          <DetailRow label="Settlement txHash" value={appWalletOperation.treasurySwapTxHash} />
                        )}
                        {appWalletOperation.payoutTxHash && (
                          <DetailRow label="Payout txHash" value={appWalletOperation.payoutTxHash} />
                        )}
                        {appWalletOperation.circleTransactionId && (
                          <DetailRow label="Circle transaction" value={appWalletOperation.circleTransactionId} />
                        )}
                        {appWalletOperation.circleReferenceId && (
                          <DetailRow label="Circle reference" value={appWalletOperation.circleReferenceId} />
                        )}
                        {appWalletOperation.executionError && (
                          <DetailRow label="Error" value={appWalletOperation.executionError} />
                        )}
                        {appWalletOperation.depositConfirmationError && (
                          <DetailRow label="Deposit note" value={appWalletOperation.depositConfirmationError} />
                        )}
                        <DetailRow label="Settlement address" value={appWalletOperation.treasuryDepositAddress} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })() : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isSuccessDialogOpen} onOpenChange={setIsSuccessDialogOpen}>
        <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
          <div className="relative overflow-hidden p-6">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
            <div
              className={`mb-5 flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ${
                successState?.status === "pending"
                  ? "bg-amber-500/12 text-amber-300 ring-amber-400/20"
                  : "bg-emerald-500/12 text-emerald-400 ring-emerald-400/20"
              }`}
            >
              {successState?.status === "pending" ? (
                <Clock3 className="h-7 w-7" />
              ) : (
                <CheckCircle2 className="h-7 w-7" />
              )}
            </div>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl">
                {successState?.status === "pending"
                  ? "Swap Pending"
                  : successState?.walletMode === "circle"
                    ? "Payout Confirmed"
                    : "Swap Confirmed"}
              </DialogTitle>
              <DialogDescription>
                {successState?.status === "pending"
                  ? successState.walletMode === "circle"
                    ? "App Wallet swap is waiting for confirmed payout."
                    : "Transaction submitted. Waiting for confirmation."
                  : successState?.walletMode === "circle"
                  ? "Payout is confirmed on Arc Testnet."
                  : "Your external wallet submitted the Arc Testnet swap transaction."}
              </DialogDescription>
            </DialogHeader>

            {successState ? (
              <div className="mt-6 space-y-4">
                {successState.status === "success" ? (() => {
                  const xShareUrl = buildXShareUrl({
                    summary:
                      successState.walletMode === "circle"
                        ? `WizPay Circle App Wallet swap: ${successState.amountIn} ${successState.tokenIn} to ${successState.tokenOut} on Arc Testnet.`
                        : `WizPay external-wallet swap: ${successState.amountIn} ${successState.tokenIn} to ${successState.tokenOut} on Arc Testnet.`,
                    explorerUrl: successState.explorerUrl ?? undefined,
                    secondaryText: `Reference: ${successState.txHash ?? successState.referenceId}`,
                  });

                  return (
                    <Button
                      variant="outline"
                      className="w-full gap-2 border-[#1DA1F2]/50 text-[#1DA1F2] hover:bg-[#1DA1F2]/10"
                      asChild
                    >
                      <a href={xShareUrl} target="_blank" rel="noreferrer">
                        <MessageCircle className="h-4 w-4" />
                        Share to X (Twitter)
                      </a>
                    </Button>
                  );
                })() : null}

                <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Route</span>
                    <span className="font-medium">
                      {successState.tokenIn} to {successState.tokenOut}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Amount in</span>
                    <span className="font-mono font-medium">
                      {successState.amountIn} {successState.tokenIn}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Expected out
                    </span>
                    <span className="font-mono font-medium">
                      {successState.amountOut ?? "Returned by Circle when available"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Execution
                    </span>
                    <span className="text-right font-medium">
                      {successState.walletMode === "circle"
                        ? "Circle App Wallet challenge"
                        : "External wallet"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Instructions
                    </span>
                    <span className="font-mono font-medium">
                      {successState.instructionCount}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Transaction
                    </span>
                    <span className="font-mono font-medium">
                      {successState.txHash
                        ? shortenHash(successState.txHash)
                        : "Pending by reference"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Circle status
                    </span>
                    <span className="font-mono font-medium">
                      {successState.transactionStatus ?? "-"}
                    </span>
                  </div>
                  {successState.transactionId ? (
                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground/70">
                        Transaction id
                      </span>
                      <span className="min-w-0 break-all text-right font-mono font-medium">
                        {successState.transactionId}
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Reference
                    </span>
                    <span className="min-w-0 break-all text-right font-mono font-medium">
                      {successState.referenceId}
                    </span>
                  </div>
                  {!successState.txHash ? (
                    <p className="mt-3 text-xs text-muted-foreground/70">
                      Circle returned a referenceId but no txHash. The
                      transaction is not shown as settled until Circle returns a
                      txHash.
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  {successState.explorerUrl ? (
                    <Button asChild className="flex-1">
                      <a
                        href={successState.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View transaction
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setIsSuccessDialogOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
