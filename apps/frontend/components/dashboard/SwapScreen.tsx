"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, ShieldCheck } from "lucide-react";
import { type Hex } from "viem";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const quoteSequence = useRef(0);
  const operationIdempotencyKey = useRef<string | null>(null);

  const amountUnits = useMemo(
    () => parseAmountToUnits(amountIn, SUPPORTED_TOKENS[tokenIn].decimals),
    [amountIn, tokenIn],
  );
  const requestKey =
    walletAddress && amountUnits > 0n && tokenIn !== tokenOut
      ? [
          walletMode,
          walletAddress.toLowerCase(),
          tokenIn,
          tokenOut,
          amountUnits.toString(),
        ].join("|")
      : null;
  const isExternal = walletMode === "external";
  const isCircle = walletMode === "circle";

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
      setTxHash(null);
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
    setStatus("signing");
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
      onRequestStatus: (next) =>
        setStatus(
          next === "idle"
            ? "idle"
            : next === "approving"
              ? "approving"
              : next === "confirming"
                ? "confirming"
                : next === "signing"
                  ? "signing"
                  : "executing",
        ),
    });
    if (
      completed.lifecycleStage !== "completed" ||
      completed.terminalStatus !== "confirmed" ||
      !completed.swapTransactionHash
    ) {
      throw new Error(
        completed.failureReason ?? "App Wallet swap did not complete.",
      );
    }
    setTxHash(completed.swapTransactionHash as Hex);
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
    await submitExternalSwap(async () => {
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
        setStatus("approving");
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
      }
      setStatus("executing");
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
      setStatus("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      verifyExternalXylonetReceipt({
        receipt,
        expected: { ...validated, walletAddress },
      });
      setTxHash(hash);
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
    try {
      if (isCircle) await executeAppWalletSwap();
      else await executeExternalWalletSwap();
      toast({
        title: "Swap confirmed",
        description: `${tokenIn} to ${tokenOut} completed through XyloNet.`,
      });
    } catch (cause) {
      const message = getFriendlyErrorMessage(cause);
      setError(message);
      toast({
        title: "Swap failed closed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setStatus("idle");
    }
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

  return (
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
            />
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                From
              </label>
              <Select
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
                  <SelectItem value="USDC">USDC</SelectItem>
                  <SelectItem value="EURC">EURC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label="Reverse tokens"
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
                  <SelectItem value="EURC">EURC</SelectItem>
                  <SelectItem value="USDC">USDC</SelectItem>
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
              <span>
                {expectedOutput
                  ? `${formatTokenAmount(expectedOutput, SUPPORTED_TOKENS[tokenOut].decimals)} ${tokenOut}`
                  : "—"}
              </span>
            </div>
            <div className="mt-2 flex justify-between">
              <span className="text-muted-foreground">Minimum output</span>
              <span>
                {minimumOutput
                  ? `${formatTokenAmount(minimumOutput, SUPPORTED_TOKENS[tokenOut].decimals)} ${tokenOut}`
                  : "—"}
              </span>
            </div>
          </div>
          <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
            {isCircle
              ? "Circle User-Controlled Wallet signs approval and swap challenges. No custodial intermediary or backend signer is used."
              : "Your connected browser wallet signs approval and the canonical executor transaction directly."}
          </div>
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
          {txHash ? (
            <p className="break-all text-xs text-emerald-400">
              Confirmed transaction: {txHash}
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
            Provider failures stop execution. No alternate provider or signer is
            selected.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
