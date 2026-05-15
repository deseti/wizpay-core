"use client";

import { useMemo, useState } from "react";
import { type Hex, formatUnits } from "viem";
import {
  ArrowRightLeft,
  CheckCircle2,
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

const APP_WALLET_SWAP_BLOCK_MESSAGE =
  "Circle App Wallet swap signing is not enabled yet. Use an external EVM wallet on Arc Testnet.";

type RequestStatus = "idle" | "quoting" | "preparing" | "signing";

interface SwapSuccessState {
  amountIn: string;
  amountOut: string | null;
  explorerUrl: string;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  txHash: Hex;
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
  quote: UserSwapQuoteResponse | null,
  tokenOut: TokenSymbol,
) {
  if (!quote) {
    return null;
  }

  return formatBaseUnitAmount(
    quote.expectedOutput ??
      findFirst(quote.raw, [
        "quote.estimatedAmount",
        "quote.route.steps.0.estimate.toAmount",
        "estimatedOutput",
        "amountOut",
      ]),
    tokenOut,
  );
}

function getQuoteMinimumOutput(
  quote: UserSwapQuoteResponse | null,
  tokenOut: TokenSymbol,
) {
  if (!quote) {
    return null;
  }

  return formatBaseUnitAmount(
    quote.minimumOutput ??
      findFirst(quote.raw, ["quote.minAmount", "minimumOutput", "minOutput"]),
    tokenOut,
  );
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
  const [quote, setQuote] = useState<UserSwapQuoteResponse | null>(null);
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
  const isExternalWalletOnArc = walletClient?.chain?.id === arcTestnet.id;
  const swapAdapter = useMemo(
    () =>
      isExternalWalletMode
        ? createArcSwapAdapter(publicClient, walletClient)
        : null,
    [isExternalWalletMode, publicClient, walletClient],
  );
  const modeBlockMessage = !isExternalWalletMode
    ? APP_WALLET_SWAP_BLOCK_MESSAGE
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
    quote?.tokenIn === tokenIn &&
    quote.tokenOut === tokenOut &&
    quote.amountIn === amountInBaseUnits &&
    quote.fromAddress.toLowerCase() === walletAddress?.toLowerCase();
  const expectedOutput = quoteMatchesForm
    ? getQuoteExpectedOutput(quote, tokenOut)
    : null;
  const minimumOutput = quoteMatchesForm
    ? getQuoteMinimumOutput(quote, tokenOut)
    : null;
  const busy = requestStatus !== "idle" || isGuarded;
  const actionDisabled =
    busy || formInvalid || insufficientBalance || Boolean(modeBlockMessage);

  function resetSwapFeedback() {
    setErrorMessage(null);
    setSuccessState(null);
    setQuote(null);
  }

  function getRequestBase() {
    if (!walletAddress) {
      throw new Error("Connect an external wallet before starting a swap.");
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
      const nextQuote = await quoteUserSwap(getRequestBase());
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

  async function handleSwap() {
    if (modeBlockMessage) {
      setErrorMessage(modeBlockMessage);
      return;
    }

    if (!walletClient) {
      setErrorMessage("Connect an external EVM wallet before swapping.");
      return;
    }

    if (formInvalid) {
      setErrorMessage("Connect a wallet and enter a valid swap amount first.");
      return;
    }

    if (insufficientBalance) {
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
      const prepared = await prepareUserSwap({
        ...getRequestBase(),
        slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
      });

      if (!swapAdapter) {
        throw new Error("Swap adapter is not ready for the connected external wallet.");
      }

      setRequestStatus("signing");
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
        tokenIn,
        tokenOut,
        txHash,
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
            External wallet Arc Testnet swap. Signed by connected external
            wallet.
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
                  Balance:{" "}
                  {formatTokenAmount(currentBalance, tokenInConfig.decimals)}{" "}
                  {tokenIn}
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

            {insufficientBalance && amountInUnits > 0n && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
                Insufficient {tokenIn} balance.
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                variant="outline"
                onClick={() => void requestQuote()}
                disabled={actionDisabled}
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
                disabled={actionDisabled}
                className="glow-btn h-12 bg-gradient-to-r from-primary to-violet-500 text-base text-primary-foreground shadow-lg shadow-primary/20"
              >
                {requestStatus === "preparing" || requestStatus === "signing" ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {requestStatus === "signing" ? "Signing..." : "Preparing..."}
                  </span>
                ) : (
                  <>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Swap
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
              Only Arc Testnet USDC and EURC are enabled. The backend returns
              Circle execution parameters; the connected external wallet signs
              the approval and swap actions.
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={isSuccessDialogOpen} onOpenChange={setIsSuccessDialogOpen}>
        <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
          <div className="relative overflow-hidden p-6">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-400 ring-1 ring-emerald-400/20">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl">Swap Submitted</DialogTitle>
              <DialogDescription>
                Your external wallet submitted the Arc Testnet swap transaction.
              </DialogDescription>
            </DialogHeader>

            {successState ? (
              <div className="mt-6 space-y-4">
                {(() => {
                  const xShareUrl = buildXShareUrl({
                    summary: `WizPay external-wallet swap: ${successState.amountIn} ${successState.tokenIn} to ${successState.tokenOut} on Arc Testnet.`,
                    explorerUrl: successState.explorerUrl,
                    secondaryText: `Reference: ${successState.txHash}`,
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
                })()}

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
                      Transaction
                    </span>
                    <span className="font-mono font-medium">
                      {shortenHash(successState.txHash)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
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
