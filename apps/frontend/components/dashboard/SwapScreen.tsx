"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, ShieldCheck } from "lucide-react";
import { formatUnits } from "viem";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";

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
import { useTokenBalances } from "@/hooks/useTokenBalances";
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
  ARC_GAS_FALLBACK_UNITS,
  calculateArcMaxAmount,
  gasReserveFromFeeWei,
  hasArcGasForAmount,
  sumGasReserves,
} from "@/lib/arc-gas-reserve";
import {
  prepareMainnetSwap,
  quoteUserSwap,
  USER_SWAP_CHAIN,
  type UserSwapQuoteResponse,
} from "@/lib/user-swap-service";
import { activeArcChain } from "@/lib/wagmi";
import {
  PREVIEW_SLIPPAGE_BPS,
  SUPPORTED_TOKENS,
  formatTokenAmount,
  getFriendlyErrorMessage,
  parseAmountToUnits,
  type TokenSymbol,
} from "@/lib/wizpay";
import { useCapability } from "@/components/providers/CapabilityProvider";
import { applySlippage } from "@/lib/mainnet-uniswap-v4-protocol";
import {
  ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE,
  useMainnetUniswapV4Gate,
} from "@/lib/mainnet-uniswap-v4";

type RequestStatus =
  | "idle"
  | "quoting"
  | "preparing"
  | "approving"
  | "signing"
  | "executing"
  | "confirming"
  | "completed";

function readPositiveAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  return amount > 0n ? amount : null;
}

function readQuoteAmountOut(quote: UserSwapQuoteResponse | null): bigint | null {
  if (!quote) return null;
  const raw =
    (quote as { expectedOutput?: unknown }).expectedOutput ??
    quote.expectedAmountOut ??
    quote.minimumAmountOut ??
    quote.minAmountOut ??
    (quote.raw as { expectedAmountOut?: unknown } | null)?.expectedAmountOut ??
    (quote.raw as { minimumAmountOut?: unknown } | null)?.minimumAmountOut;
  if (typeof raw === "bigint") return raw > 0n ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : null;
  }
  return null;
}

export function SwapScreen() {
  const swapCapability = useCapability("swap");
  if (!swapCapability.enabled) {
    return (
      <p role="alert" className="text-sm text-amber-300">
        {swapCapability.unavailableMessage}
      </p>
    );
  }
  return <SwapWorkspace swapCapability={swapCapability} />;
}

function SwapWorkspace({
  swapCapability,
}: {
  swapCapability: ReturnType<typeof useCapability>;
}) {
  const { walletAddress } = useActiveWalletAddress();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: activeArcChain.id });
  const { balances, isLoading: balancesLoading } = useTokenBalances();
  const { toast } = useToast();

  const [tokenIn, setTokenIn] = useState<TokenSymbol>("USDC");
  const [tokenOut, setTokenOut] = useState<TokenSymbol>("EURC");
  const [amountIn, setAmountIn] = useState("");
  const [quote, setQuote] = useState<UserSwapQuoteResponse | null>(null);
  const [quoteKey, setQuoteKey] = useState<string | null>(null);
  const [status, setStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [swapSuccess, setSwapSuccess] = useState<SwapSuccessResult | null>(
    null,
  );
  const [successOpen, setSuccessOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressStatus, setProgressStatus] =
    useState<SwapProgressRequestStatus>("preparing");
  const [progressFailure, setProgressFailure] = useState<string | null>(null);
  const [approvalRequired, setApprovalRequired] = useState<boolean | null>(
    null,
  );
  const [gasReserveUnits, setGasReserveUnits] = useState(
    ARC_GAS_FALLBACK_UNITS,
  );
  const [gasReserveSource, setGasReserveSource] = useState<
    "estimate" | "fallback"
  >("fallback");
  const [estimatingMax, setEstimatingMax] = useState(false);
  const showQuoteSkeleton = useDelayedLoading(status === "quoting");
  const quoteSequence = useRef(0);
  const transactionActive = useRef(false);

  const poolGate = useMainnetUniswapV4Gate();
  const poolBlocked = !poolGate.available || !poolGate.executable;
  const poolBlockedMessage =
    poolGate.message ?? ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE;

  function setTransactionStatus(next: SwapProgressRequestStatus) {
    setProgressStatus(next);
    setStatus(next);
  }

  const amountUnits = useMemo(
    () => parseAmountToUnits(amountIn, SUPPORTED_TOKENS[tokenIn].decimals),
    [amountIn, tokenIn],
  );
  const requestKey =
    walletAddress && amountUnits > 0n && tokenIn !== tokenOut
      ? [
          walletAddress.toLowerCase(),
          tokenIn,
          tokenOut,
          amountUnits.toString(),
        ].join("|")
      : null;
  const { data: externalBalance = 0n } = useReadContract({
    address: SUPPORTED_TOKENS[tokenIn].address,
    abi: ERC20_ABI,
    chainId: activeArcChain.id,
    functionName: "balanceOf",
    args: walletAddress ? [walletAddress] : undefined,
    query: { enabled: Boolean(walletAddress) },
  });

  useEffect(() => {
    queueMicrotask(() => {
      setQuote(null);
      setQuoteKey(null);
      setError(null);
    });
    if (!requestKey || !walletAddress) return;

    const controller = new AbortController();
    const sequence = ++quoteSequence.current;
    const timer = setTimeout(async () => {
      setStatus("quoting");
      try {
        const next = await quoteUserSwap(
          {
            tokenIn,
            tokenOut,
            amountIn: amountUnits.toString(),
            fromAddress: walletAddress,
            toAddress: walletAddress,
            chain: USER_SWAP_CHAIN,
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
  }, [amountUnits, requestKey, tokenIn, tokenOut, walletAddress]);

  const quoteCurrent = Boolean(quote && requestKey && quoteKey === requestKey);
  const expectedOutput = quoteCurrent ? readQuoteAmountOut(quote) : null;
  const minimumOutput = useMemo(() => {
    if (!expectedOutput) return null;
    try {
      return applySlippage(expectedOutput, Number(PREVIEW_SLIPPAGE_BPS));
    } catch {
      return null;
    }
  }, [expectedOutput]);
  const blockedReason = !walletAddress
    ? "Connect an external wallet."
    : walletClient && walletClient.chain?.id !== activeArcChain.id
      ? "Switch the external wallet to Arc Mainnet (chain 5042)."
      : !walletClient
        ? "Connect an external browser wallet."
        : poolBlocked
          ? poolBlockedMessage
          : null;

  async function executeMainnetSwap() {
    if (!quote || !walletAddress || !walletClient || !publicClient) {
      throw new Error("A current Mainnet quote is required.");
    }
    if (poolBlocked) {
      throw new Error(poolBlockedMessage);
    }
    const raw = quote.raw as {
      observation?: unknown;
      expiresAt?: unknown;
      expectedAmountOut?: unknown;
    } | null;
    if (
      typeof raw?.expiresAt === "string" &&
      Number.isFinite(Date.parse(raw.expiresAt)) &&
      Date.now() > Date.parse(raw.expiresAt)
    ) {
      throw new Error("Quote expired. Wait for a new Mainnet quote.");
    }
    if (!raw || typeof raw.observation !== "object" || !raw.observation) {
      throw new Error("A current Arc Mainnet Swap Executor quote is required.");
    }
    if (amountUnits <= 0n) {
      throw new Error("Enter a positive swap amount.");
    }
    const tokenInAddress = SUPPORTED_TOKENS[tokenIn].address;
    const tokenOutAddress = SUPPORTED_TOKENS[tokenOut].address;
    const deadline = Math.floor(Date.now() / 1_000) + 600;
    // Single authoritative plan: the backend re-validates the boundary,
    // rejects stale quotes against the live head, and builds the exact
    // executor calldata. The wallet signs exactly these values.
    const plan = await prepareMainnetSwap({
      chainId: activeArcChain.id as 5042,
      tokenInAddress,
      tokenOutAddress,
      amountIn: amountUnits.toString(),
      recipient: walletAddress,
      walletAddress,
      walletControl: "external-wallet",
      slippageBps: Number(PREVIEW_SLIPPAGE_BPS),
      deadline,
      quoteResult: raw.observation,
    });
    if (plan.chainId !== activeArcChain.id) {
      throw new Error("Swap plan chain does not match Arc Mainnet.");
    }
    const planAmountIn = BigInt(plan.quote.amountIn);
    const planAmountOut = BigInt(plan.quote.amountOut);
    if (planAmountIn !== amountUnits || planAmountOut <= 0n) {
      throw new Error("Swap plan does not match the quoted amount.");
    }
    if (plan.approvals.length > 0) {
      setApprovalRequired(true);
      setTransactionStatus("approving");
      const approval = plan.approvals[0]!;
      const approvalHash = await walletClient.sendTransaction({
        to: approval.to as `0x${string}`,
        data: approval.data,
        value: BigInt(approval.value),
        account: walletAddress,
        chain: activeArcChain,
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
    const hash = await walletClient.sendTransaction({
      to: plan.swap.to as `0x${string}`,
      data: plan.swap.data,
      value: BigInt(plan.swap.value),
      account: walletAddress,
      chain: activeArcChain,
    });
    setTransactionStatus("confirming");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Swap transaction reverted.");
    return {
      hash,
      inputAmount: amountUnits,
      outputAmount: planAmountOut,
      inputToken: tokenIn,
      outputToken: tokenOut,
    };
  }

  async function handleSwap() {
    swapCapability.assertEnabled();
    setError(null);
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    if (poolBlocked) {
      setError(poolBlockedMessage);
      return;
    }
    if (!quoteCurrent || !quote) {
      setError("Wait for a current Mainnet quote.");
      return;
    }
    if (transactionActive.current) return;
    const currentInputBalance = balances[tokenIn];
    if (
      !hasArcGasForAmount({
        amountUnits,
        inputBalance: currentInputBalance,
        nativeUsdcBalance: balances.USDC,
        reserveUnits: gasReserveUnits,
        tokenIsUsdc: tokenIn === "USDC",
      })
    ) {
      setError("Leave enough USDC available for network fees.");
      return;
    }
    transactionActive.current = true;
    setProgressFailure(null);
    setApprovalRequired(null);
    setProgressOpen(true);
    setTransactionStatus("preparing");
    try {
      const completed = await executeMainnetSwap();
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
        walletMode: "External Wallet",
        network: activeArcChain.name,
        transactionHash: completed.hash,
        explorerUrl: activeArcChain.blockExplorers
          ? `${activeArcChain.blockExplorers.default.url}/tx/${completed.hash}`
          : undefined,
      });
      setProgressOpen(false);
      setSuccessOpen(true);
      toast({
        title: "Swap confirmed",
        description: `${completed.inputToken} to ${completed.outputToken} completed on Arc Mainnet.`,
      });
    } catch (cause) {
      const message = getFriendlyErrorMessage(cause);
      setError(message);
      setProgressFailure(message);
      const statusUnavailable =
        /failed to fetch|network|temporarily unavailable|timeout|timed out|unavailable/i.test(
          message,
        );
      toast({
        title: statusUnavailable ? "Swap status unavailable" : "Swap stopped",
        description: message,
        variant: statusUnavailable ? "default" : "destructive",
      });
    } finally {
      setStatus("idle");
      transactionActive.current = false;
    }
  }

  async function handleMax() {
    const inputBalance = balances[tokenIn];
    if (!walletAddress || inputBalance <= 0n || progressOpen) return;
    setEstimatingMax(true);
    setError(null);
    let reserve: { reserveUnits: bigint; source: "estimate" | "fallback" } = {
      reserveUnits: ARC_GAS_FALLBACK_UNITS,
      source: "fallback",
    };
    try {
      if (publicClient) {
        const gasPrice = await publicClient.getGasPrice();
        const fees: Array<bigint | null> = [];
        fees.push(
          (await publicClient.estimateContractGas({
            account: walletAddress,
            address: SUPPORTED_TOKENS[tokenIn].address,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [walletAddress, inputBalance],
          })) * gasPrice,
        );
        reserve = sumGasReserves(fees);
      }
    } catch {
      reserve = gasReserveFromFeeWei(null);
    }
    setGasReserveUnits(reserve.reserveUnits);
    setGasReserveSource(reserve.source);
    const max = calculateArcMaxAmount({
      inputBalance,
      nativeUsdcBalance: balances.USDC,
      reserveUnits: reserve.reserveUnits,
      tokenIsUsdc: tokenIn === "USDC",
    });
    if (max <= 0n) setError("Leave enough USDC available for network fees.");
    else setAmountIn(formatUnits(max, SUPPORTED_TOKENS[tokenIn].decimals));
    setEstimatingMax(false);
  }

  function handleDismissProgressFailure() {
    setProgressOpen(false);
    setProgressFailure(null);
  }

  function handleStartAnotherSwap() {
    setSuccessOpen(false);
    setSwapSuccess(null);
    setError(null);
    setProgressOpen(false);
    setProgressFailure(null);
    setApprovalRequired(null);
    setAmountIn("");
  }

  const busy = status !== "idle";
  const inputBalance = externalBalance;
  const insufficient =
    amountUnits > inputBalance ||
    (amountUnits > 0n &&
      !hasArcGasForAmount({
        amountUnits,
        inputBalance,
        nativeUsdcBalance: balances.USDC,
        reserveUnits: gasReserveUnits,
        tokenIsUsdc: tokenIn === "USDC",
      }));
  const disabled =
    !swapCapability.enabled ||
    busy ||
    poolBlocked ||
    Boolean(blockedReason) ||
    !quoteCurrent ||
    !expectedOutput ||
    !minimumOutput ||
    insufficient ||
    balancesLoading;

  return (
    <div>
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
              <div className="flex items-center justify-between">
                <label className="text-sm text-muted-foreground">Amount</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    progressOpen ||
                    balancesLoading ||
                    balances[tokenIn] === 0n ||
                    estimatingMax
                  }
                  onClick={() => void handleMax()}
                >
                  {estimatingMax ? "Estimating…" : "Max"}
                </Button>
              </div>
              <Input
                aria-label="Swap amount"
                value={amountIn}
                onChange={(event) => setAmountIn(event.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                disabled={progressOpen}
              />
              <p className="text-xs text-muted-foreground">
                Max leaves at least {formatUnits(gasReserveUnits, 6)} USDC
                available for network fees
                {gasReserveSource === "fallback"
                  ? " when a live estimate is unavailable"
                  : ""}
                .
              </p>
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
                    <SelectItem value="USDC">
                      <span className="flex items-center gap-2">
                        <TokenIcon
                          chainId={activeArcChain.id}
                          address={SUPPORTED_TOKENS.USDC.address}
                          symbol="USDC"
                          size={28}
                        />
                        USDC
                      </span>
                    </SelectItem>
                    <SelectItem value="EURC">
                      <span className="flex items-center gap-2">
                        <TokenIcon
                          chainId={activeArcChain.id}
                          address={SUPPORTED_TOKENS.EURC.address}
                          symbol="EURC"
                          size={28}
                        />
                        EURC
                      </span>
                    </SelectItem>
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
                    <SelectItem value="EURC">
                      <span className="flex items-center gap-2">
                        <TokenIcon
                          chainId={activeArcChain.id}
                          address={SUPPORTED_TOKENS.EURC.address}
                          symbol="EURC"
                          size={28}
                        />
                        EURC
                      </span>
                    </SelectItem>
                    <SelectItem value="USDC">
                      <span className="flex items-center gap-2">
                        <TokenIcon
                          chainId={activeArcChain.id}
                          address={SUPPORTED_TOKENS.USDC.address}
                          symbol="USDC"
                          size={28}
                        />
                        USDC
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="rounded-xl border border-border/30 bg-background/20 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Provider</span>
                <span>Mainnet Swap Executor</span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Executor</span>
                <span>WizPaySwapExecutorMainnet</span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Expected output</span>
                {showQuoteSkeleton ? (
                  <Skeleton className="h-4 w-24" />
                ) : (
                  <span>
                    {expectedOutput
                      ? `${formatTokenAmount(expectedOutput, SUPPORTED_TOKENS[tokenOut].decimals)} ${tokenOut}`
                      : "—"}
                  </span>
                )}
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Minimum output</span>
                {showQuoteSkeleton ? (
                  <Skeleton className="h-4 w-24" />
                ) : (
                  <span>
                    {minimumOutput
                      ? `${formatTokenAmount(minimumOutput, SUPPORTED_TOKENS[tokenOut].decimals)} ${tokenOut}`
                      : "—"}
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
              Your connected external wallet signs approval and the Mainnet
              executor transaction directly on Arc Mainnet.
            </div>
            {poolBlocked ? (
              <div
                role="alert"
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
              >
                {poolBlockedMessage}
              </div>
            ) : null}
            {progressOpen ? (
              <SwapProgress
                tokenIn={tokenIn}
                tokenOut={tokenOut}
                amount={amountIn}
                requestStatus={progressStatus}
                approvalRequired={approvalRequired}
                failure={progressFailure}
                onDismissFailure={handleDismissProgressFailure}
              />
            ) : null}
            {blockedReason || (error ? (
              <div
                role="alert"
                className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                {error ?? blockedReason}
              </div>
            ) : null)}
            {insufficient ? (
              <div role="alert" className="text-sm text-amber-300">
                {amountUnits > inputBalance
                  ? `Insufficient ${tokenIn} balance.`
                  : "Leave enough USDC available for network fees."}
              </div>
            ) : null}
            {!swapCapability.enabled ? (
              <div role="alert" className="text-sm text-amber-300">
                {swapCapability.unavailableMessage}
              </div>
            ) : null}
            <Button
              className="h-12 w-full"
              disabled={disabled}
              onClick={() => void handleSwap()}
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              {busy ? status : "Swap on Arc Mainnet"}
            </Button>
          </CardContent>
        </Card>
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle>Locked route</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              USDC and EURC swaps on Arc Mainnet (chain 5042) use the Mainnet
              Swap Executor only.
            </p>
            <p>
              Pool unavailability stops execution. No alternate provider or
              signer is selected.
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
