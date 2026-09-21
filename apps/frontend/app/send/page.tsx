"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2, QrCode, RefreshCw, Send } from "lucide-react";
import {
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { usePublicClient, useSwitchChain } from "wagmi";

import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import { TransactionSuccessDialog } from "@/components/dashboard/TransactionSuccessDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenIcon } from "@/components/ui/token-icon";
import { SendPageSkeleton } from "@/components/ui/skeleton-loaders";
import { useExternalWallet } from "@/components/providers/external-wallet-context";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useTransactionExecutor } from "@/hooks/useTransactionExecutor";
import { ERC20_ABI } from "@/constants/erc20";
import { parseEvmPaymentPayload } from "@/lib/evm-payment-uri";
import { verifyErc20Transfer } from "@/lib/send-transaction";
import {
  ARC_GAS_FALLBACK_UNITS,
  calculateArcMaxAmount,
  gasReserveFromFeeWei,
  hasArcGasForAmount,
} from "@/lib/arc-gas-reserve";
import {
  clearExternalSendRecovery,
  readExternalSendRecovery,
  writeExternalSendRecovery,
  type ExternalWalletSendRecovery,
} from "@/lib/send-operation";
import {
  ARC_CHAIN_ID,
  formatCompactAddress,
  formatTokenAmount,
  getExplorerTxUrl,
  SUPPORTED_TOKENS,
  TOKEN_OPTIONS,
  type TokenSymbol,
} from "@/lib/wizpay";
import { useCapability } from "@/components/providers/CapabilityProvider";
import {
  acquireExecutionIntent,
  bindKnownExecutionIntentHash,
  bindExecutionIntentTransactionHash,
  cancelExecutionIntent,
  verifyDirectExecutionIntent,
} from "@/lib/execution-intent";
import { activeArcChain } from "@/lib/wagmi";

type SendStage =
  | "idle"
  | "validating"
  | "awaiting_network_switch"
  | "awaiting_signature"
  | "submitting"
  | "confirming"
  | "verifying"
  | "completed"
  | "recoverable_error";

const STAGE_COPY: Record<Exclude<SendStage, "idle" | "completed">, string> = {
  validating: "Validating transfer details",
  awaiting_network_switch: "Awaiting network switch to Arc Mainnet",
  awaiting_signature: "Confirm this transfer in your external wallet",
  submitting: "Submitting transfer",
  confirming: "Waiting for Arc Mainnet confirmation",
  verifying: "Verifying recipient, amount, token, sender, and receipt",
  recoverable_error:
    "We could not confirm the current status yet. The existing transfer remains recoverable.",
};

function exactAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized))
    throw new Error("Enter a valid positive amount.");
  const fraction = normalized.split(".")[1] ?? "";
  if (fraction.length > decimals)
    throw new Error(`Amount supports at most ${decimals} decimal places.`);
  const units = parseUnits(normalized, decimals);
  if (units <= 0n) throw new Error("Amount must be greater than zero.");
  return units;
}

function readPrefill(searchParams: URLSearchParams) {
  const rawRecipient = searchParams.get("recipient");
  if (!rawRecipient)
    return {
      recipient: "",
      token: "USDC" as TokenSymbol,
      amount: "",
      scanned: false,
      error: null as string | null,
    };
  try {
    const queryToken = searchParams.get("token");
    const queryAmount = searchParams.get("amount");
    const queryChain = searchParams.get("chainId");
    const tokenConfig = queryToken
      ? SUPPORTED_TOKENS[queryToken as TokenSymbol]
      : undefined;
    const action = queryToken
      ? `${tokenConfig?.address ?? ""}${queryChain ? `@${queryChain}` : ""}/transfer?address=${rawRecipient}&uint256=${queryAmount && tokenConfig ? parseUnits(queryAmount, tokenConfig.decimals) : ""}`
      : `${rawRecipient}${queryChain ? `@${queryChain}` : ""}`;
    const prefill = parseEvmPaymentPayload(`ethereum:${action}`);
    return {
      recipient: prefill.recipient,
      token: prefill.token ?? "USDC",
      amount: prefill.amount ?? "",
      scanned: searchParams.get("scanned") === "1",
      error: null,
    };
  } catch (cause) {
    return {
      recipient: "",
      token: "USDC" as TokenSymbol,
      amount: "",
      scanned: false,
      error: cause instanceof Error ? cause.message : "Invalid Send prefill.",
    };
  }
}

function SendWorkspace() {
  const sendCapability = useCapability("send");
  const searchParams = useSearchParams();
  const initialPrefill = useMemo(
    () => readPrefill(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const wallet = useExternalWallet();
  const {
    balances,
    isError: balanceError,
    isLoading: balancesLoading,
    refetch,
  } = useTokenBalances();
  const showInitialSkeleton = useDelayedLoading(
    balancesLoading && wallet.isActiveWalletConnected,
  );
  const { executeTransaction } = useTransactionExecutor();
  const publicClient = usePublicClient({ chainId: activeArcChain.id });
  const { switchChainAsync } = useSwitchChain();
  const [recipient, setRecipient] = useState(initialPrefill.recipient);
  const [tokenSymbol, setTokenSymbol] = useState<TokenSymbol>(
    initialPrefill.token,
  );
  const [amount, setAmount] = useState(initialPrefill.amount);
  const [scanned, setScanned] = useState(initialPrefill.scanned);
  const [stage, setStage] = useState<SendStage>("idle");
  const [error, setError] = useState<string | null>(initialPrefill.error);
  const [verifiedHash, setVerifiedHash] = useState<Hex | null>(null);
  const [completed, setCompleted] = useState<{
    amount: string;
    recipient: Address;
    token: TokenSymbol;
  } | null>(null);
  const submittingRef = useRef(false);
  const submittedRef = useRef(false);
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const [externalRecovery, setExternalRecovery] =
    useState<ExternalWalletSendRecovery | null>(null);
  const [knownRecoveryHash, setKnownRecoveryHash] = useState("");
  const [gasReserveUnits, setGasReserveUnits] = useState(
    ARC_GAS_FALLBACK_UNITS,
  );
  const [gasReserveSource, setGasReserveSource] = useState<
    "estimate" | "fallback"
  >("fallback");
  const [estimatingGas, setEstimatingGas] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const statusInFlightRef = useRef(false);
  const formVersion = useRef(0);
  const token = SUPPORTED_TOKENS[tokenSymbol];
  const busy = stage !== "idle" && stage !== "completed";
  const formLocked = busy || submissionLocked || !sendCapability.enabled;

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (
      !wallet.activeWalletAddress ||
      !isAddress(wallet.activeWalletAddress)
    ) {
      queueMicrotask(() => setExternalRecovery(null));
      return;
    }
    const recovered = readExternalSendRecovery(
      typeof window === "undefined" ? undefined : window.localStorage,
      getAddress(wallet.activeWalletAddress),
      activeArcChain.id,
    );
    queueMicrotask(() => {
      setExternalRecovery(recovered);
      if (!recovered) return;
      setRecipient(recovered.recipient);
      setTokenSymbol(recovered.token);
      setAmount(recovered.amountDisplay);
      setVerifiedHash(recovered.txHash ?? null);
      setSubmissionLocked(true);
      setStage(recovered.txHash ? "confirming" : "recoverable_error");
      if (!recovered.txHash)
        setError(
          "The wallet may have broadcast this transfer without returning its hash. WizPay will not request another transfer automatically.",
        );
      else if (publicClient) {
        void (async () => {
          try {
            await bindKnownExecutionIntentHash(
              recovered.executionIntentId,
              recovered.idempotencyKey,
              recovered.txHash!,
            );
            setStage("verifying");
            await verifyErc20Transfer({
              amount: BigInt(recovered.amountUnits),
              hash: recovered.txHash!,
              publicClient,
              recipient: recovered.recipient,
              sender: recovered.sender,
              token: recovered.tokenAddress,
            });
            await verifyDirectExecutionIntent(
              recovered.executionIntentId,
              recovered.idempotencyKey,
            );
            clearExternalSendRecovery(window.localStorage, recovered);
            setExternalRecovery(null);
            setCompleted({
              amount: recovered.amountDisplay,
              recipient: recovered.recipient,
              token: recovered.token,
            });
            setSubmissionLocked(false);
            setStage("completed");
            await refetch();
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "The saved transfer could not be reconciled safely.",
            );
            setStage("recoverable_error");
          }
        })();
      }
    });
  }, [publicClient, refetch, wallet.activeWalletAddress]);

  const balance = balances[tokenSymbol];
  const nativeUsdcBalance = balances.USDC;
  const available = useMemo(
    () => formatTokenAmount(balance, token.decimals),
    [balance, token.decimals],
  );

  function mutate(action: () => void) {
    if (formLocked) return;
    formVersion.current += 1;
    setError(null);
    action();
  }

  async function estimateSendGas(units: bigint, checkedRecipient: Address) {
    try {
      if (!publicClient || !wallet.activeWalletAddress)
        throw new Error("Arc Mainnet client is unavailable.");
      const gas = await publicClient.estimateContractGas({
        account: getAddress(wallet.activeWalletAddress),
        address: token.address,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [checkedRecipient, units],
      });
      const gasPrice = await publicClient.getGasPrice();
      return gasReserveFromFeeWei(gas * gasPrice);
    } catch {
      return gasReserveFromFeeWei(null);
    }
  }

  async function selectMax() {
    if (!wallet.activeWalletAddress || balance === 0n || formLocked) return;
    setEstimatingGas(true);
    setError(null);
    const estimateRecipient = isAddress(recipient)
      ? getAddress(recipient)
      : getAddress(wallet.activeWalletAddress);
    const reserve = await estimateSendGas(balance, estimateRecipient);
    setGasReserveUnits(reserve.reserveUnits);
    setGasReserveSource(reserve.source);
    const max = calculateArcMaxAmount({
      inputBalance: balance,
      nativeUsdcBalance,
      reserveUnits: reserve.reserveUnits,
      tokenIsUsdc: token.symbol === "USDC",
    });
    if (max <= 0n) setError("Leave enough USDC available for network fees.");
    else setAmount(formatUnits(max, token.decimals));
    setEstimatingGas(false);
  }

  async function submit() {
    sendCapability.assertEnabled();
    if (submittingRef.current) return;
    submittingRef.current = true;
    const startedVersion = formVersion.current;
    const startedAddress = wallet.activeWalletAddress;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setError(null);
      setStage("validating");
      if (!wallet.isReady)
        throw new Error("The selected wallet is still loading.");
      if (!wallet.isActiveWalletConnected || !wallet.activeWalletAddress)
        throw new Error("Connect the external wallet before sending.");
      if (!publicClient) throw new Error("Arc Mainnet client is unavailable.");
      if (!isAddress(recipient))
        throw new Error("Enter a valid EVM recipient address.");
      const checkedRecipient = getAddress(recipient);
      if (/^0x0{40}$/i.test(checkedRecipient))
        throw new Error("The zero address cannot receive a payment.");
      const units = exactAmount(amount, token.decimals);
      if (units > balance)
        throw new Error(`Insufficient ${token.symbol} balance.`);
      const reserve = await estimateSendGas(units, checkedRecipient);
      setGasReserveUnits(reserve.reserveUnits);
      setGasReserveSource(reserve.source);
      if (
        !hasArcGasForAmount({
          amountUnits: units,
          inputBalance: balance,
          nativeUsdcBalance,
          reserveUnits: reserve.reserveUnits,
          tokenIsUsdc: token.symbol === "USDC",
        })
      )
        throw new Error("Leave enough USDC available for network fees.");
      if (wallet.activeWalletChainId !== activeArcChain.id) {
        setStage("awaiting_network_switch");
        await switchChainAsync({ chainId: activeArcChain.id });
      }
      setStage("awaiting_signature");
      const refId = `SEND-${crypto.randomUUID()}`;
      const intent = await acquireExecutionIntent({
        network: "arc-mainnet",
        operation: "SEND",
        sourceWallet: wallet.activeWalletAddress,
        recipient: checkedRecipient,
        tokenIn: token.address,
        tokenOut: token.address,
        amountUnits: units.toString(),
        externalReference: refId,
      });
      const idempotencyKey = intent.idempotencyKey;
      const externalRecoveryHolder: {
        value?: ExternalWalletSendRecovery;
      } = {};
      const result = await executeTransaction({
        abi: ERC20_ABI,
        args: [checkedRecipient, units],
        chainId: activeArcChain.id,
        contractAddress: token.address,
        functionName: "transfer",
        idempotencyKey,
        executionIntentId: intent.id,
        memo: `WizPay Send ${token.symbol}`,
        refId,
        onWalletPrepared: async (leaseOwner) => {
          const now = new Date().toISOString();
          const preparedExternalRecovery: ExternalWalletSendRecovery = {
            version: 1,
            executionIntentId: intent.id,
            idempotencyKey: intent.idempotencyKey,
            leaseOwner,
            operationId: refId,
            chainId: activeArcChain.id,
            sender: getAddress(wallet.activeWalletAddress!),
            token: token.symbol,
            tokenAddress: token.address,
            recipient: checkedRecipient,
            amountUnits: units.toString(),
            amountDisplay: formatUnits(units, token.decimals),
            createdAt: now,
            stage: "awaiting_wallet_signature",
          };
          externalRecoveryHolder.value = preparedExternalRecovery;
          setExternalRecovery(preparedExternalRecovery);
          setSubmissionLocked(true);
          writeExternalSendRecovery(
            typeof window === "undefined" ? undefined : window.localStorage,
            preparedExternalRecovery,
          );
        },
      });
      submittedRef.current = true;
      setSubmissionLocked(true);
      if (
        !startedAddress ||
        startedVersion !== formVersion.current ||
        startedAddress.toLowerCase() !==
          wallet.activeWalletAddress?.toLowerCase()
      )
        throw new Error(
          "Wallet or form state changed while sending. Verification stopped.",
        );
      setStage("submitting");
      const hash = result.txHash;
      if (!hash) {
        throw new Error(
          "The submitted transaction did not return an on-chain hash.",
        );
      }
      const preparedExternalRecovery = externalRecoveryHolder.value;
      if (preparedExternalRecovery) {
        const recoveryWithHash: ExternalWalletSendRecovery = {
          ...preparedExternalRecovery,
          txHash: hash,
          stage: "confirming_onchain",
        };
        setExternalRecovery(recoveryWithHash);
        writeExternalSendRecovery(
          typeof window === "undefined" ? undefined : window.localStorage,
          recoveryWithHash,
        );
      }
      await bindExecutionIntentTransactionHash(
        intent.id,
        hash,
        intent.idempotencyKey,
        result.executionLeaseOwner,
      );
      setStage("confirming");
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      setStage("verifying");
      await verifyErc20Transfer({
        amount: units,
        hash,
        publicClient,
        recipient: checkedRecipient,
        sender: wallet.activeWalletAddress,
        token: token.address,
      });
      await verifyDirectExecutionIntent(intent.id, intent.idempotencyKey);
      setVerifiedHash(hash);
      setCompleted({
        amount: formatUnits(units, token.decimals),
        recipient: checkedRecipient,
        token: token.symbol,
      });
      setStage("completed");
      if (preparedExternalRecovery) {
        clearExternalSendRecovery(
          typeof window === "undefined" ? undefined : window.localStorage,
          preparedExternalRecovery,
        );
        setExternalRecovery(null);
      }
      await refetch();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        const message =
          cause instanceof Error
            ? cause.message
            : "Transfer could not be completed.";
        setError(message);
      }
      if (!externalRecovery) setStage("idle");
    } finally {
      submittingRef.current = false;
      abortRef.current = null;
    }
  }

  async function recoverExternalTransactionHash() {
    if (
      !externalRecovery ||
      !/^0x[a-fA-F0-9]{64}$/.test(knownRecoveryHash.trim()) ||
      !publicClient
    ) {
      setError("Enter a complete 32-byte transaction hash.");
      return;
    }
    const hash = knownRecoveryHash.trim() as Hex;
    setCheckingStatus(true);
    try {
      await bindKnownExecutionIntentHash(
        externalRecovery.executionIntentId,
        externalRecovery.idempotencyKey,
        hash,
      );
      const next = {
        ...externalRecovery,
        txHash: hash,
        stage: "confirming_onchain" as const,
      };
      setExternalRecovery(next);
      setVerifiedHash(hash);
      writeExternalSendRecovery(window.localStorage, next);
      setStage("verifying");
      await verifyErc20Transfer({
        amount: BigInt(next.amountUnits),
        hash,
        publicClient,
        recipient: next.recipient,
        sender: next.sender,
        token: next.tokenAddress,
      });
      await verifyDirectExecutionIntent(
        next.executionIntentId,
        next.idempotencyKey,
      );
      clearExternalSendRecovery(window.localStorage, next);
      setExternalRecovery(null);
      setCompleted({
        amount: next.amountDisplay,
        recipient: next.recipient,
        token: next.token,
      });
      setError(null);
      setSubmissionLocked(false);
      setStage("completed");
      await refetch();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The transaction could not be reconciled safely.",
      );
      setStage("recoverable_error");
    } finally {
      setCheckingStatus(false);
    }
  }

  async function cancelExternalIntent() {
    if (!externalRecovery || externalRecovery.txHash) return;
    setCheckingStatus(true);
    try {
      await cancelExecutionIntent(
        externalRecovery.executionIntentId,
        externalRecovery.idempotencyKey,
      );
      clearExternalSendRecovery(window.localStorage, externalRecovery);
      setExternalRecovery(null);
      setSubmissionLocked(false);
      setError(null);
      setStage("idle");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The unresolved transfer could not be cancelled safely.",
      );
    } finally {
      setCheckingStatus(false);
    }
  }

  function reset() {
    if (stage !== "completed" && stage !== "recoverable_error") {
      if (externalRecovery) return;
    }
    if (externalRecovery && externalRecovery.txHash) return;
    setRecipient("");
    setAmount("");
    setScanned(false);
    setError(null);
    setVerifiedHash(null);
    setCompleted(null);
    setSubmissionLocked(false);
    setExternalRecovery(null);
    submittedRef.current = false;
    setStage("idle");
    formVersion.current += 1;
  }

  if (showInitialSkeleton) return <SendPageSkeleton />;

  const statusStage = busy ? stage : null;

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Send</h1>
          <p className="text-sm text-muted-foreground">
            Send one token transfer to one EVM recipient on Arc Mainnet.
          </p>
        </div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
          <Card className="glass-card border-border/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5 text-primary" />
                Transfer details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="send-recipient">Recipient EVM address</Label>
                <Input
                  id="send-recipient"
                  value={recipient}
                  disabled={formLocked}
                  onChange={(event) =>
                    mutate(() => {
                      setRecipient(event.target.value);
                      setScanned(false);
                    })
                  }
                  placeholder="0x..."
                  className="font-mono"
                />
                {scanned ? (
                  <p className="flex items-center gap-1.5 text-xs text-primary">
                    <QrCode className="h-3.5 w-3.5" />
                    Verified QR prefill — review before sending
                  </p>
                ) : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="send-token">Token</Label>
                  <div className="relative">
                    <TokenIcon
                      chainId={activeArcChain.id}
                      address={token.address}
                      symbol={token.symbol}
                      size={28}
                      className="pointer-events-none absolute left-2 top-1.5 z-10"
                    />
                    <select
                      id="send-token"
                      value={tokenSymbol}
                      disabled={formLocked}
                      onChange={(event) =>
                        mutate(() =>
                          setTokenSymbol(event.target.value as TokenSymbol),
                        )
                      }
                      className="h-10 w-full rounded-md border border-input bg-background pl-11 pr-3 text-sm"
                    >
                      {TOKEN_OPTIONS.map((option) => (
                        <option key={option.symbol} value={option.symbol}>
                          {option.symbol} — {option.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="send-amount">Amount</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={formLocked || balance === 0n || estimatingGas}
                      onClick={() => void selectMax()}
                    >
                      {estimatingGas ? "Estimating…" : "Max"}
                    </Button>
                  </div>
                  <Input
                    id="send-amount"
                    inputMode="decimal"
                    value={amount}
                    disabled={formLocked}
                    onChange={(event) =>
                      mutate(() => setAmount(event.target.value))
                    }
                    placeholder="0.00"
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
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border/40 bg-background/30 px-4 py-3 text-sm">
                <span className="text-muted-foreground">Available balance</span>
                <span className="flex items-center gap-2 font-mono">
                  <TokenIcon
                    chainId={activeArcChain.id}
                    address={token.address}
                    symbol={token.symbol}
                    size={20}
                  />
                  {available} {token.symbol}
                </span>
              </div>
              {balanceError ? (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-100">
                  Balance could not be loaded. Sending is disabled until it is
                  refreshed.
                </div>
              ) : null}
              {error ? (
                <div
                  role="alert"
                  className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              ) : null}
              {statusStage ? (
                <div
                  role="status"
                  className="rounded-xl border border-primary/25 bg-primary/10 p-4"
                >
                  <p className="flex items-center gap-2 font-medium text-primary">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Transfer in progress
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {
                      STAGE_COPY[
                        statusStage as Exclude<SendStage, "idle" | "completed">
                      ]
                    }
                  </p>
                  {externalRecovery && !externalRecovery.txHash ? (
                    <div className="mt-3 space-y-3 rounded-lg border border-amber-500/30 p-3">
                      <Input
                        aria-label="Known transaction hash"
                        placeholder="0x… transaction hash"
                        value={knownRecoveryHash}
                        onChange={(event) =>
                          setKnownRecoveryHash(event.target.value)
                        }
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={checkingStatus}
                          onClick={() => void recoverExternalTransactionHash()}
                        >
                          Bind and verify hash
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={checkingStatus}
                          onClick={() => void cancelExternalIntent()}
                        >
                          Cancel unsubmitted intent
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Cancel only after checking wallet activity and
                        confirming no broadcast occurred. Browser wallets can
                        broadcast before their provider returns a hash.
                      </p>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {statusInFlightRef.current ? (
                      <Button size="sm" variant="outline" disabled>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                        Checking…
                      </Button>
                    ) : null}
                    {stage === "recoverable_error" ? (
                      <Button size="sm" variant="outline" onClick={reset}>
                        Start over
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <Button
                className="w-full"
                disabled={
                  formLocked ||
                  balancesLoading ||
                  balanceError ||
                  !wallet.isReady ||
                  !wallet.isActiveWalletConnected
                }
                onClick={() => void submit()}
              >
                {submissionLocked
                  ? "Existing transfer is being recovered"
                  : sendCapability.enabled
                    ? "Review and send"
                    : "Send unavailable"}
              </Button>
              {!sendCapability.enabled ? (
                <p role="alert" className="text-sm text-amber-300">
                  {sendCapability.unavailableMessage}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card className="glass-card h-fit border-border/40">
            <CardHeader>
              <CardTitle className="text-base">Transfer summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Token</span>
                <span className="flex items-center gap-2">
                  <TokenIcon
                    chainId={activeArcChain.id}
                    address={token.address}
                    symbol={token.symbol}
                    size={24}
                  />
                  {token.symbol}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Wallet mode</span>
                <span>External Wallet</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Network</span>
                <span>Arc Mainnet · 5042</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Sender</span>
                <span className="font-mono">
                  {wallet.activeWalletAddress
                    ? formatCompactAddress(wallet.activeWalletAddress)
                    : "Not connected"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Fee / gas</span>
                <span className="text-right">
                  Shown by wallet when available
                </span>
              </div>
              <p className="border-t border-border/30 pt-3 text-xs text-muted-foreground">
                WizPay submits one ordinary transfer on Arc Mainnet. No batch
                or alternate route is used.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      <TransactionSuccessDialog
        open={stage === "completed" && Boolean(completed && verifiedHash)}
        title="Transfer completed"
        description="The exact confirmed transfer and receipt evidence were verified on Arc Mainnet."
        rows={
          completed
            ? [
                {
                  label: "Amount",
                  value: (
                    <span className="flex items-center gap-2">
                      <TokenIcon
                        chainId={activeArcChain.id}
                        address={SUPPORTED_TOKENS[completed.token].address}
                        symbol={completed.token}
                        size={24}
                      />
                      {completed.amount} {completed.token}
                    </span>
                  ),
                },
                {
                  label: "Recipient",
                  value: (
                    <span className="break-all font-mono text-xs">
                      {completed.recipient}
                    </span>
                  ),
                },
                {
                  label: "Sender wallet",
                  value: "External Wallet",
                },
                { label: "Network", value: "Arc Mainnet · 5042" },
              ]
            : []
        }
        transactionHash={verifiedHash ?? undefined}
        explorerUrl={getExplorerTxUrl(verifiedHash, ARC_CHAIN_ID) ?? undefined}
        onDone={() => setStage("idle")}
        onStartAnother={reset}
        startAnotherLabel="Send another"
      />
    </>
  );
}

export default function SendPage() {
  return (
    <DashboardAppFrame>
      <Suspense fallback={<SendPageSkeleton />}>
        <SendWorkspace />
      </Suspense>
    </DashboardAppFrame>
  );
}
