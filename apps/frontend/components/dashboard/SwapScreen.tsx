"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, ShieldCheck } from "lucide-react";
import { type Hex } from "viem";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { ExternalBridgePanel } from "@/components/dashboard/ExternalBridgePanel";
import {
  SwapSuccessDialog,
  type SwapSuccessResult,
} from "@/components/dashboard/SwapSuccessDialog";
import {
  SwapProgress,
  type SwapProgressRequestStatus,
} from "@/components/dashboard/SwapProgress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenIcon } from "@/components/ui/token-icon";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ERC20_ABI } from "@/constants/erc20";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useToast } from "@/hooks/use-toast";
import {
  APP_WALLET_SWAP_CHAIN,
  createAppWalletXylonetOperation,
  quoteAppWalletXylonetSwap,
  type AppWalletSwapQuoteResponse,
  type AppWalletXylonetOperationResponse,
} from "@/lib/app-wallet-swap-service";
import {
  WIZPAY_SWAP_EXECUTOR_V2_ABI,
  createSwapSubmissionLock,
  validateExternalXylonetQuote,
  verifyExternalXylonetReceipt,
} from "@/lib/external-xylonet-swap";
import { runAppWalletXylonetLifecycle } from "@/lib/app-wallet-xylonet-lifecycle";
import {
  quoteUserSwap,
  type UserSwapQuoteResponse,
} from "@/lib/user-swap-service";
import { arcTestnet } from "@/lib/wagmi";
import {
  PREVIEW_SLIPPAGE_BPS,
  SUPPORTED_TOKENS,
  formatTokenAmount,
  getFriendlyErrorMessage,
  parseAmountToUnits,
  type TokenSymbol,
} from "@/lib/wizpay";

type QuoteState = AppWalletSwapQuoteResponse | UserSwapQuoteResponse;
type RequestStatus =
  | "idle"
  | "quoting"
  | "preparing"
  | "approving"
  | "signing"
  | "executing"
  | "confirming";

const submitExternalSwap = createSwapSubmissionLock();

function sameAddress(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function readPositiveAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  return amount > 0n ? amount : null;
}

function assertAppWalletQuote(input: {
  quote: AppWalletSwapQuoteResponse;
  walletAddress: string;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
}) {
  const expectedExecutor =
    process.env.NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS;
  if (
    input.quote.provider !== "xylonet" ||
    input.quote.sourceChain !== APP_WALLET_SWAP_CHAIN ||
    input.quote.tokenIn !== input.tokenIn ||
    input.quote.tokenOut !== input.tokenOut ||
    input.quote.amountIn !== input.amountIn ||
    !sameAddress(input.quote.walletAddress, input.walletAddress) ||
    !sameAddress(input.quote.recipientAddress, input.walletAddress) ||
    !sameAddress(input.quote.executorAddress, expectedExecutor) ||
    !readPositiveAmount(input.quote.expectedOutput) ||
    !readPositiveAmount(input.quote.minimumOutput)
  )
    throw new Error(
      "App Wallet XyloNet quote does not match the current swap request.",
    );
  if (
    !input.quote.expiresAt ||
    Date.parse(input.quote.expiresAt) <= Date.now()
  ) {
    throw new Error("App Wallet XyloNet quote has expired.");
  }
}

export function SwapScreen() {
  const { walletAddress, walletMode } = useActiveWalletAddress();
  const { arcWallet, executeChallenge, userToken } = useCircleWallet();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { toast } = useToast();

  const [tokenIn, setTokenIn] = useState<TokenSymbol>("USDC");
  const [tokenOut, setTokenOut] = useState<TokenSymbol>("EURC");
  const [amountIn, setAmountIn] = useState("");
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [quoteKey, setQuoteKey] = useState<string | null>(null);
  const [operation, setOperation] =
    useState<AppWalletXylonetOperationResponse | null>(null);
  const [status, setStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [swapSuccess, setSwapSuccess] = useState<SwapSuccessResult | null>(null);
  const [successOpen, setSuccessOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressStatus, setProgressStatus] =
    useState<SwapProgressRequestStatus>("preparing");
  const [progressFailure, setProgressFailure] = useState<string | null>(null);
  const [approvalRequired, setApprovalRequired] = useState<boolean | null>(null);
  const [screenMode, setScreenMode] = useState<"swap" | "bridge">("swap");
  const showQuoteSkeleton = useDelayedLoading(status === "quoting");
  const quoteSequence = useRef(0);
  const operationIdempotencyKey = useRef<string | null>(null);
  const transactionActive = useRef(false);

  function setTransactionStatus(next: SwapProgressRequestStatus) {
    setProgressStatus(next);
    setStatus(next);
  }

  const amountUnits = useMemo(
    () => parseAmountToUnits(amountIn, SUPPORTED_TOKENS[tokenIn].decimals),
    [amountIn, tokenIn],
  );
  const isExternal = walletMode === "external";
  const isCircle = walletMode === "circle";
  const effectiveScreenMode = isExternal ? screenMode : "swap";
  const requestKey =
    effectiveScreenMode === "swap" &&
    walletAddress &&
    amountUnits > 0n &&
    tokenIn !== tokenOut
      ? [
          walletMode,
          walletAddress.toLowerCase(),
          tokenIn,
          tokenOut,
          amountUnits.toString(),
        ].join("|")
      : null;
  const { data: externalBalance = 0n } = useReadContract({
    address: SUPPORTED_TOKENS[tokenIn].address,
    abi: ERC20_ABI,
    chainId: arcTestnet.id,
    functionName: "balanceOf",
    args: walletAddress ? [walletAddress] : undefined,
    query: { enabled: Boolean(isExternal && walletAddress) },
  });

  useEffect(() => {
    queueMicrotask(() => {
      setQuote(null);
      setQuoteKey(null);
      setOperation(null);
      setError(null);
    });
    operationIdempotencyKey.current = null;
    if (!requestKey || !walletAddress || (!isCircle && !isExternal)) return;

    const controller = new AbortController();
    const sequence = ++quoteSequence.current;
    const timer = setTimeout(async () => {
      setStatus("quoting");
      try {
        const next = isCircle
          ? await quoteAppWalletXylonetSwap(
              {
                idempotencyKey: crypto.randomUUID(),
                walletId: arcWallet?.id ?? "",
                walletAddress,
                chain: APP_WALLET_SWAP_CHAIN,
                tokenIn,
                tokenOut,
                amountIn: amountUnits.toString(),
                slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
              },
              userToken ?? "",
              { signal: controller.signal },
            )
          : await quoteUserSwap(
              {
                tokenIn,
                tokenOut,
                amountIn: amountUnits.toString(),
                fromAddress: walletAddress,
                toAddress: walletAddress,
                chain: "ARC-TESTNET",
                slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
              },
              { signal: controller.signal },
            );
        if (sequence !== quoteSequence.current) return;
        setQuote(next);
        setQuoteKey(requestKey);
      } catch (cause) {
        if (controller.signal.aborted || sequence !== quoteSequence.current)
          return;
        setError(getFriendlyErrorMessage(cause));
      } finally {
        if (sequence === quoteSequence.current) setStatus("idle");
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    amountUnits,
    arcWallet?.id,
    isCircle,
    isExternal,
    requestKey,
    tokenIn,
    tokenOut,
    userToken,
    walletAddress,
  ]);

  const quoteCurrent = Boolean(quote && requestKey && quoteKey === requestKey);
  const expectedOutput = quoteCurrent
    ? readPositiveAmount(quote?.expectedOutput)
    : null;
  const minimumOutput = quoteCurrent
    ? readPositiveAmount(
        quote?.minimumOutput ??
          (quote as UserSwapQuoteResponse | null)?.minimumAmountOut,
      )
    : null;
  const blockedReason = !walletAddress
    ? "Connect an App Wallet or external wallet."
    : !isCircle && !isExternal
      ? "Select App Wallet or External Wallet mode."
      : isExternal && walletClient?.chain?.id !== arcTestnet.id
        ? "Switch the external wallet to Arc Testnet."
        : isCircle && (!arcWallet?.id || !userToken)
          ? "Circle User-Controlled App Wallet session is not ready."
          : isExternal && !walletClient
            ? "Connect an external browser wallet."
            : null;

  async function executeAppWalletSwap() {
    if (
      !quote ||
      !("sourceChain" in quote) ||
      !walletAddress ||
      !arcWallet?.id ||
      !userToken ||
      !requestKey
    ) {
      throw new Error("A current App Wallet XyloNet quote is required.");
    }
    assertAppWalletQuote({
      quote,
      walletAddress,
      tokenIn,
      tokenOut,
      amountIn: amountUnits.toString(),
    });
    const idempotencyKey =
      operationIdempotencyKey.current ?? crypto.randomUUID();
    operationIdempotencyKey.current = idempotencyKey;
    const created = await createAppWalletXylonetOperation(
      {
        idempotencyKey,
        walletId: arcWallet.id,
        walletAddress,
        chain: APP_WALLET_SWAP_CHAIN,
        tokenIn,
        tokenOut,
        amountIn: amountUnits.toString(),
        slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
      },
      userToken,
    );
    setOperation(created);
    const completed = await runAppWalletXylonetLifecycle({
      initialOperation: created,
      userToken,
      executeChallenge,
      onOperation: setOperation,
      onRequestStatus: (next) => {
        if (next === "idle") return;
        setTransactionStatus(
          next === "approving"
            ? "approving"
            : next === "confirming" || next === "settling"
              ? "confirming"
              : next === "signing"
                ? "signing"
                : "executing",
        );
      },
    });
    const verifiedOutput = readPositiveAmount(completed.verifiedActualOutput);
    if (
      completed.lifecycleStage !== "completed" ||
      completed.terminalStatus !== "confirmed" ||
      !completed.swapTransactionHash ||
      !verifiedOutput
    ) {
      throw new Error(
        completed.failureReason ?? "App Wallet swap did not complete.",
      );
    }
    return {
      hash: completed.swapTransactionHash as Hex,
      inputAmount: BigInt(completed.amountIn),
      outputAmount: verifiedOutput,
      inputToken: completed.tokenIn,
      outputToken: completed.tokenOut,
    };
  }

  async function executeExternalWalletSwap() {
    if (
      !quote ||
      "sourceChain" in quote ||
      !walletAddress ||
      !walletClient ||
      !publicClient
    ) {
      throw new Error("A current External Wallet XyloNet quote is required.");
    }
    return submitExternalSwap(async () => {
      const validated = validateExternalXylonetQuote(quote, {
        walletAddress,
        chainId: walletClient.chain?.id ?? 0,
        tokenIn,
        tokenOut,
        tokenInAddress: SUPPORTED_TOKENS[tokenIn].address,
        tokenOutAddress: SUPPORTED_TOKENS[tokenOut].address,
        amountIn: amountUnits,
      });
      const allowance = await publicClient.readContract({
        address: validated.tokenIn,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [walletAddress, validated.executor],
      });
      if (allowance < validated.amountIn) {
        setApprovalRequired(true);
        setTransactionStatus("approving");
        const approvalHash = await walletClient.writeContract({
          address: validated.tokenIn,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [validated.executor, validated.amountIn],
          account: walletAddress,
          chain: arcTestnet,
        });
        const approvalReceipt = await publicClient.waitForTransactionReceipt({
          hash: approvalHash,
        });
        if (approvalReceipt.status !== "success")
          throw new Error("Executor approval transaction reverted.");
      } else {
        setApprovalRequired(false);
      }
      setTransactionStatus("signing");
      const hash = await walletClient.writeContract({
        address: validated.executor,
        abi: WIZPAY_SWAP_EXECUTOR_V2_ABI,
        functionName: "executeSwap",
        args: [
          validated.router,
          validated.tokenIn,
          validated.tokenOut,
          validated.amountIn,
          validated.minimumAmountOut,
          validated.recipient,
          validated.deadline,
        ],
        account: walletAddress,
        chain: arcTestnet,
      });
      setTransactionStatus("executing");
      setTransactionStatus("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const outputAmount = verifyExternalXylonetReceipt({
        receipt,
        expected: { ...validated, walletAddress },
      });
      return {
        hash,
        inputAmount: validated.amountIn,
        outputAmount,
        inputToken: tokenIn,
        outputToken: tokenOut,
      };
    });
  }

  async function handleSwap() {
    setError(null);
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    if (!quoteCurrent || !quote) {
      setError("Wait for a current XyloNet quote.");
      return;
    }
    if (transactionActive.current) return;
    transactionActive.current = true;
    setProgressFailure(null);
    setApprovalRequired(isCircle ? true : null);
    setProgressOpen(true);
    setTransactionStatus("preparing");
    try {
      const completed = isCircle
        ? await executeAppWalletSwap()
        : await executeExternalWalletSwap();
      setSwapSuccess({
        inputAmount: formatTokenAmount(
          completed.inputAmount,
          SUPPORTED_TOKENS[completed.inputToken].decimals,
        ),
        inputToken: completed.inputToken,
        outputAmount: formatTokenAmount(
          completed.outputAmount,
          SUPPORTED_TOKENS[completed.outputToken].decimals,
        ),
        outputToken: completed.outputToken,
        walletMode: isCircle ? "App Wallet" : "External Wallet",
        network: arcTestnet.name,
        transactionHash: completed.hash,
        explorerUrl: `${arcTestnet.blockExplorers.default.url}/tx/${completed.hash}`,
      });
      setProgressOpen(false);
      setSuccessOpen(true);
      toast({
        title: "Swap confirmed",
        description: `${completed.inputToken} to ${completed.outputToken} completed through XyloNet.`,
      });
    } catch (cause) {
      const message = getFriendlyErrorMessage(cause);
      setError(message);
      setProgressFailure(message);
      toast({
        title: "Swap failed closed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setStatus("idle");
      transactionActive.current = false;
    }
  }

  function handleDismissProgressFailure() {
    setProgressOpen(false);
    setProgressFailure(null);
  }

  function handleStartAnotherSwap() {
    setSuccessOpen(false);
    setSwapSuccess(null);
    setOperation(null);
    setError(null);
    setProgressOpen(false);
    setProgressFailure(null);
    setApprovalRequired(null);
    setAmountIn("");
  }

  const busy = status !== "idle";
  const insufficient = isExternal && amountUnits > externalBalance;
  const disabled =
    busy ||
    Boolean(blockedReason) ||
    !quoteCurrent ||
    !expectedOutput ||
    !minimumOutput ||
    insufficient;

  const modeSelector = isExternal ? (
    <div
      aria-label="Swap or Bridge mode"
      className="mb-5 grid w-full max-w-sm grid-cols-2 rounded-xl border border-border/40 bg-background/30 p-1"
    >
      <Button
        type="button"
        variant={screenMode === "swap" ? "default" : "ghost"}
        onClick={() => setScreenMode("swap")}
      >
        Swap
      </Button>
      <Button
        type="button"
        variant={screenMode === "bridge" ? "default" : "ghost"}
        onClick={() => setScreenMode("bridge")}
      >
        Bridge
      </Button>
    </div>
  ) : null;

  if (effectiveScreenMode === "bridge" && isExternal && walletAddress) {
    return (
      <div>
        {modeSelector}
        <ExternalBridgePanel walletAddress={walletAddress} />
      </div>
    );
  }

  return (
    <div>
      {modeSelector}
      <div className="grid gap-6 lg:grid-cols-[1.4fr_0.6fr]">
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              Swap
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Amount</label>
              <Input
                aria-label="Swap amount"
                value={amountIn}
                onChange={(event) => setAmountIn(event.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                disabled={progressOpen}
              />
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">
                  From
                </label>
                <Select
                  disabled={progressOpen}
                  value={tokenIn}
                  onValueChange={(value) => {
                    const next = value as TokenSymbol;
                    setTokenIn(next);
                    if (next === tokenOut)
                      setTokenOut(next === "USDC" ? "EURC" : "USDC");
                  }}
                >
                  <SelectTrigger aria-label="From token">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USDC"><span className="flex items-center gap-2"><TokenIcon chainId={arcTestnet.id} address={SUPPORTED_TOKENS.USDC.address} symbol="USDC" size={28} />USDC</span></SelectItem>
                    <SelectItem value="EURC"><span className="flex items-center gap-2"><TokenIcon chainId={arcTestnet.id} address={SUPPORTED_TOKENS.EURC.address} symbol="EURC" size={28} />EURC</span></SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                size="icon"
                aria-label="Reverse tokens"
                disabled={progressOpen}
                onClick={() => {
                  setTokenIn(tokenOut);
                  setTokenOut(tokenIn);
                }}
              >
                <ArrowRightLeft className="h-4 w-4" />
              </Button>
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">
                  To
                </label>
                <Select
                  disabled={progressOpen}
                  value={tokenOut}
                  onValueChange={(value) => {
                    const next = value as TokenSymbol;
                    setTokenOut(next);
                    if (next === tokenIn)
                      setTokenIn(next === "USDC" ? "EURC" : "USDC");
                  }}
                >
                  <SelectTrigger aria-label="To token">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EURC"><span className="flex items-center gap-2"><TokenIcon chainId={arcTestnet.id} address={SUPPORTED_TOKENS.EURC.address} symbol="EURC" size={28} />EURC</span></SelectItem>
                    <SelectItem value="USDC"><span className="flex items-center gap-2"><TokenIcon chainId={arcTestnet.id} address={SUPPORTED_TOKENS.USDC.address} symbol="USDC" size={28} />USDC</span></SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="rounded-xl border border-border/30 bg-background/20 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Provider</span>
                <span>XyloNet</span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Executor</span>
                <span>WizPaySwapExecutorV2</span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Expected output</span>
                {showQuoteSkeleton ? <Skeleton className="h-4 w-24" /> : <span>
                  {expectedOutput
                    ? `${formatTokenAmount(expectedOutput, SUPPORTED_TOKENS[tokenOut].decimals)} ${tokenOut}`
                    : "—"}
                </span>}
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Minimum output</span>
                {showQuoteSkeleton ? <Skeleton className="h-4 w-24" /> : <span>
                  {minimumOutput
                    ? `${formatTokenAmount(minimumOutput, SUPPORTED_TOKENS[tokenOut].decimals)} ${tokenOut}`
                    : "—"}
                </span>}
              </div>
            </div>
            <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
              {isCircle
                ? "Circle User-Controlled Wallet signs approval and swap challenges. No custodial intermediary or backend signer is used."
                : "Your connected browser wallet signs approval and the canonical executor transaction directly."}
            </div>
            {progressOpen ? (
              <SwapProgress
                walletMode={isCircle ? "circle" : "external"}
                tokenIn={tokenIn}
                tokenOut={tokenOut}
                amount={amountIn}
                requestStatus={progressStatus}
                lifecycleStage={operation?.lifecycleStage}
                approvalRequired={approvalRequired}
                failure={progressFailure}
                onDismissFailure={handleDismissProgressFailure}
              />
            ) : null}
            {blockedReason || error ? (
              <div
                role="alert"
                className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                {error ?? blockedReason}
              </div>
            ) : null}
            {insufficient ? (
              <div role="alert" className="text-sm text-amber-300">
                Insufficient {tokenIn} balance.
              </div>
            ) : null}
            <Button
              className="h-12 w-full"
              disabled={disabled}
              onClick={() => void handleSwap()}
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              {busy
                ? status
                : isCircle
                  ? "Confirm XyloNet swap"
                  : "Swap with XyloNet"}
            </Button>
            {operation ? (
              <p className="text-xs text-muted-foreground">
                App Wallet lifecycle: {operation.lifecycleStage}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle>Locked route</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>USDC and EURC swaps on Arc Testnet use XyloNet only.</p>
            <p>
              Provider failures stop execution. No alternate provider or signer
              is selected.
            </p>
          </CardContent>
        </Card>
      </div>
      {swapSuccess ? (
        <SwapSuccessDialog
          open={successOpen}
          result={swapSuccess}
          onDone={() => setSuccessOpen(false)}
          onStartAnother={handleStartAnotherSwap}
        />
      ) : null}
    </div>
  );
}
