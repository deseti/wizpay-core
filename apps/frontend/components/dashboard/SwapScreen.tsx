"use client";

import { useMemo, useState } from "react";
import { type Hex, formatUnits } from "viem";
import {
  ArrowRightLeft,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
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
  createAppWalletSwapOperation,
  quoteAppWalletSwap,
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
  | "depositing";
type SwapQuoteState = UserSwapQuoteResponse | AppWalletSwapQuoteResponse;

const EXPECTED_OUTPUT_FALLBACK_PATHS = [
  "quote.estimatedAmount",
  "quote.route.steps.0.estimate.toAmount",
  "estimatedOutput",
  "amountOut",
] as const;

const MINIMUM_OUTPUT_FALLBACK_PATHS = [
  "quote.minAmount",
  "minimumOutput",
  "minOutput",
] as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      return current[Number(key)];
    }

    if (!isRecord(current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

function findFirst(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const found = getPath(value, path);

    if (found !== undefined && found !== null) {
      return found;
    }
  }

  return undefined;
}

function findFirstString(value: unknown, paths: string[]) {
  const found = findFirst(value, paths);

  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function stringifyAmount(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (isRecord(value)) {
    return stringifyAmount(value.amount ?? value.value ?? value.toAmount);
  }

  return null;
}

function formatBaseUnitAmount(
  value: unknown,
  token: TokenSymbol,
): string | null {
  const rawAmount = stringifyAmount(value);

  if (!rawAmount) {
    return null;
  }

  try {
    return `${formatUnits(BigInt(rawAmount), SUPPORTED_TOKENS[token].decimals)} ${token}`;
  } catch {
    return `${rawAmount} ${token}`;
  }
}

function getQuoteExpectedOutput(
  quote: SwapQuoteState | null,
  tokenOut: TokenSymbol,
) {
  if (!quote) {
    return null;
  }

  const rawQuote = "raw" in quote ? quote.raw : quote.rawQuote;

  return formatBaseUnitAmount(
    quote.expectedOutput ??
      findFirst(rawQuote, [...EXPECTED_OUTPUT_FALLBACK_PATHS]),
    tokenOut,
  );
}

function getQuoteMinimumOutput(
  quote: SwapQuoteState | null,
  tokenOut: TokenSymbol,
) {
  if (!quote) {
    return null;
  }

  const rawQuote = "raw" in quote ? quote.raw : quote.rawQuote;

  return formatBaseUnitAmount(
    quote.minimumOutput ??
      findFirst(rawQuote, [...MINIMUM_OUTPUT_FALLBACK_PATHS]),
    tokenOut,
  );
}

function getOperationExpectedOutput(operation: AppWalletSwapOperationResponse) {
  return formatBaseUnitAmount(
    operation.expectedOutput ??
      findFirst(operation.rawQuote, [...EXPECTED_OUTPUT_FALLBACK_PATHS]),
    operation.tokenOut,
  );
}

function getOperationMinimumOutput(operation: AppWalletSwapOperationResponse) {
  return formatBaseUnitAmount(
    operation.minimumOutput ??
      findFirst(operation.rawQuote, [...MINIMUM_OUTPUT_FALLBACK_PATHS]),
    operation.tokenOut,
  );
}

function getCircleTxHash(...values: unknown[]): Hex | null {
  for (const value of values) {
    const candidate =
      findFirstString(value, [
        "data.txHash",
        "data.transactionHash",
        "data.hash",
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
  return formatBaseUnitAmount(
    prepared.expectedOutput ??
      findFirst(prepared.raw, [
        "quote.estimatedAmount",
        "quote.route.steps.0.estimate.toAmount",
        "estimatedOutput",
        "amountOut",
      ]),
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
    ? getQuoteExpectedOutput(quote, tokenOut)
    : null;
  const minimumOutput = quoteMatchesForm
    ? getQuoteMinimumOutput(quote, tokenOut)
    : null;
  const busy = requestStatus !== "idle" || isGuarded;
  const quoteDisabled =
    busy ||
    formInvalid ||
    (isExternalWalletMode && insufficientBalance) ||
    Boolean(modeBlockMessage);
  const swapDisabled =
    quoteDisabled || (isCircleWalletMode && !quoteMatchesForm);

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
      title: "Deposit instruction created",
      description:
        "Deposit USDC manually to the treasury address. No swap or payout has been executed.",
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

    if (appWalletOperation.tokenIn !== "USDC") {
      setErrorMessage("Phase 3B only supports manual USDC deposits.");
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
          "USDC tokenId is missing for the Circle App Wallet. Refresh wallet balances and retry.",
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

      const depositTxHash = getCircleTxHash(
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
          ...(depositTxHash ? { depositTxHash } : {}),
          ...(circleTransactionId ? { circleTransactionId } : {}),
          ...(circleReferenceId ? { circleReferenceId } : {}),
        },
      );

      setAppWalletOperation(updatedOperation);
      toast({
        title: "Deposit submitted",
        description:
          "Deposit reference attached. Backend confirmation will be added in Phase 3C.",
      });
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
              ? "Treasury-mediated App Wallet swap is experimental."
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
                    : "Treasury-mediated deposit flow"}
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
                Treasury-mediated App Wallet swap is experimental. App Wallet
                can create a deposit instruction and request a USDC transfer
                challenge to the treasury. Deposit submission is not deposit
                confirmation; backend confirmation comes in Phase 3C. Treasury
                swap, payout, refund, and settlement are not implemented yet.
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
                      ? "Creating..."
                      : requestStatus === "signing"
                      ? isCircleWalletMode
                        ? "Challenge..."
                        : "Signing..."
                      : "Preparing..."}
                  </span>
                ) : (
                  <>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    {isCircleWalletMode
                      ? quoteMatchesForm
                        ? "Create deposit instruction"
                        : "Preview quote first"
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
              Only Arc Testnet USDC and EURC are enabled. External wallets use
              the existing Circle/Viem adapter path, while Circle App Wallet
              creates a treasury deposit instruction and can request a USDC
              transfer challenge. Deposit submission still waits for future
              backend confirmation before any treasury swap, payout, refund, or
              settlement.
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
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/12 text-sky-300 ring-1 ring-sky-400/20">
              <Clock3 className="h-7 w-7" />
            </div>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl">
                Deposit Instruction Created
              </DialogTitle>
              <DialogDescription>
                Treasury-mediated App Wallet swap is waiting for a manual USDC
                deposit. Settlement is not complete.
              </DialogDescription>
            </DialogHeader>

            {appWalletOperation ? (
              <div className="mt-6 space-y-4">
                <div className="rounded-2xl border border-sky-500/25 bg-sky-500/5 p-4 text-sm text-sky-100">
                  {appWalletOperation.status === "deposit_submitted" ? (
                    <>
                      Deposit submitted. Backend confirmation will be added in
                      Phase 3C, so settlement is not complete.
                    </>
                  ) : (
                    <>
                      Deposit {formatBaseUnitAmount(
                        appWalletOperation.amountIn,
                        appWalletOperation.tokenIn,
                      ) ?? `${appWalletOperation.amountIn} ${appWalletOperation.tokenIn}`}{" "}
                      to the Arc treasury address below. The deposit action
                      requests a Circle App Wallet transfer challenge only; it
                      does not execute the treasury swap, payout, refund, or
                      settlement.
                    </>
                  )}
                </div>

                <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Operation id
                    </span>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 break-all text-right font-mono font-medium">
                        {appWalletOperation.operationId}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() =>
                          void copyToClipboard(
                            appWalletOperation.operationId,
                            "operation id",
                          )
                        }
                        aria-label="Copy operation id"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Status</span>
                    <span className="font-mono font-medium text-amber-200">
                      {appWalletOperation.status}
                    </span>
                  </div>
                  {appWalletOperation.depositTxHash ? (
                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground/70">
                        Deposit txHash
                      </span>
                      <span className="min-w-0 break-all text-right font-mono font-medium">
                        {appWalletOperation.depositTxHash}
                      </span>
                    </div>
                  ) : null}
                  {appWalletOperation.circleTransactionId ? (
                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground/70">
                        Circle transaction
                      </span>
                      <span className="min-w-0 break-all text-right font-mono font-medium">
                        {appWalletOperation.circleTransactionId}
                      </span>
                    </div>
                  ) : null}
                  {appWalletOperation.circleReferenceId ? (
                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground/70">
                        Circle reference
                      </span>
                      <span className="min-w-0 break-all text-right font-mono font-medium">
                        {appWalletOperation.circleReferenceId}
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Treasury deposit address
                    </span>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 break-all text-right font-mono font-medium">
                        {appWalletOperation.treasuryDepositAddress}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() =>
                          void copyToClipboard(
                            appWalletOperation.treasuryDepositAddress,
                            "treasury address",
                          )
                        }
                        aria-label="Copy treasury deposit address"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Deposit</span>
                    <span className="font-mono font-medium">
                      {formatBaseUnitAmount(
                        appWalletOperation.amountIn,
                        appWalletOperation.tokenIn,
                      ) ?? `${appWalletOperation.amountIn} ${appWalletOperation.tokenIn}`}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Route</span>
                    <span className="font-medium">
                      {appWalletOperation.tokenIn} to{" "}
                      {appWalletOperation.tokenOut}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Expected output
                    </span>
                    <span className="font-mono font-medium">
                      {getOperationExpectedOutput(appWalletOperation) ?? "-"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Minimum output
                    </span>
                    <span className="font-mono font-medium">
                      {getOperationMinimumOutput(appWalletOperation) ?? "-"}
                    </span>
                  </div>
                </div>

                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm text-amber-100">
                  {appWalletOperation.status === "deposit_submitted"
                    ? "Deposit submission is recorded, but it is not confirmed yet. Treasury swap execution is not executed yet. Payout is not executed yet. Settlement is not complete."
                    : "Treasury swap execution is not executed yet. Payout is not executed yet. Settlement is not complete."}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  {appWalletOperation.status === "awaiting_user_deposit" ? (
                    <Button
                      className="flex-1"
                      onClick={() => void guard(submitAppWalletDeposit)}
                      disabled={
                        requestStatus === "depositing" ||
                        appWalletOperation.tokenIn !== "USDC"
                      }
                    >
                      {requestStatus === "depositing" ? (
                        <span className="flex items-center gap-2">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          Depositing...
                        </span>
                      ) : (
                        "Deposit USDC"
                      )}
                    </Button>
                  ) : null}
                  {appWalletOperation.depositTxHash ? (
                    <Button asChild variant="outline" className="flex-1">
                      <a
                        href={`${EXPLORER_BASE_URL}/tx/${appWalletOperation.depositTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View deposit
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setIsAppWalletOperationOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>
            ) : null}
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
                  : "Swap Confirmed"}
              </DialogTitle>
              <DialogDescription>
                {successState?.status === "pending"
                  ? "Circle App Wallet transaction submitted. Waiting for settlement confirmation."
                  : successState?.walletMode === "circle"
                  ? "Signed through Circle App Wallet challenge on Arc Testnet."
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
