"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";

import { Button } from "@/components/ui/button";
import { BridgeChainLabel } from "@/components/dashboard/BridgeChainIcon";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCapability } from "@/components/providers/CapabilityProvider";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { activeArcChain } from "@/lib/wagmi";
import {
  authorizeBridgeDestination,
  createBridgeIntent,
  fetchBridgeQuote,
  getBridgeAttestation,
  getBridgeIntent,
  reportBridgeApproval,
  reportBridgeSource,
  submitBridgeDestination,
  verifyBridgeDestination,
  type BridgeIntentView,
  type BridgeQuote,
} from "@/lib/bridge-service";
import {
  addressToBytes32,
  bridgeChain,
  bridgeChains,
  CCTP_MAX_BURN_AMOUNT_UNITS,
  ERC20_APPROVE_ABI,
  CCTP_MESSAGE_TRANSMITTER_ABI,
  CCTP_TOKEN_MESSENGER_ABI,
  explorerTxUrl,
  wagmiChainForBridge,
} from "@/lib/cctp";

type BridgeStage =
  | "idle"
  | "creating"
  | "approving"
  | "burning"
  | "waiting_attestation"
  | "authorizing"
  | "minting"
  | "verifying"
  | "completed"
  | "recoverable_error";

const STAGE_COPY: Record<Exclude<BridgeStage, "idle" | "completed">, string> = {
  creating: "Creating the bridge intent with the backend",
  approving: "Confirm the USDC approval in your external wallet",
  burning: "Confirm the CCTP burn in your external wallet",
  waiting_attestation: "Waiting for the Circle attestation",
  authorizing: "Authorizing the destination mint",
  minting: "Confirm the destination mint in your external wallet",
  verifying: "Verifying the completed bridge",
  recoverable_error: "The bridge needs attention before it can continue",
};

const ATTESTATION_MAX_ATTEMPTS = 240;

const COUNTERPARTIES = bridgeChains()
  .filter((chain) => chain.code !== "ARC-MAINNET")
  .map((chain) => chain.code);

export const BRIDGE_FAST_UNAVAILABLE_MESSAGE =
  "Fast CCTP transfer is temporarily unavailable for this route.";

function recoveryKey(address: string) {
  return `wizpay.bridge-intent.v1.${address.toLowerCase()}`;
}

function parseUsdc(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error("Enter a USDC amount with at most 6 decimal places.");
  }
  const units = parseUnits(normalized, 6);
  if (units <= 0n) throw new Error("Bridge amount must be greater than zero.");
  if (units > CCTP_MAX_BURN_AMOUNT_UNITS) {
    throw new Error(
      "Bridge amount exceeds the CCTP single-transfer limit. Split the transfer.",
    );
  }
  return units;
}

export function formatUsdcUnits(units: bigint): string {
  const raw = formatUnits(units, 6);
  return raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, ".0") : raw;
}

export function BridgeScreen() {
  const capability = useCapability("bridge");
  if (!capability.enabled) {
    return (
      <p role="alert" className="text-sm text-amber-300">
        {capability.unavailableMessage}
      </p>
    );
  }
  return <BridgeWorkspace />;
}

function BridgeWorkspace() {
  const bridgeCapability = useCapability("bridge");
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();

  const [outbound, setOutbound] = useState(true);
  const [counterparty, setCounterparty] = useState<string>("ETH-MAINNET");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stage, setStage] = useState<BridgeStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<BridgeIntentView | null>(null);
  const [checking, setChecking] = useState(false);
  const running = useRef(false);
  const quoteSequence = useRef(0);

  const source = useMemo(
    () => bridgeChain(outbound ? "ARC-MAINNET" : counterparty),
    [outbound, counterparty],
  );
  const destination = useMemo(
    () => bridgeChain(outbound ? counterparty : "ARC-MAINNET"),
    [outbound, counterparty],
  );
  const sourceChain = useMemo(
    () => wagmiChainForBridge(source.code, activeArcChain),
    [source.code],
  );
  const destinationChain = useMemo(
    () => wagmiChainForBridge(destination.code, activeArcChain),
    [destination.code],
  );
  const sourcePublicClient = usePublicClient({ chainId: sourceChain.id });
  const destinationPublicClient = usePublicClient({
    chainId: destinationChain.id,
  });

  useEffect(() => {
    if (!address) {
      setIntent(null);
      setStage("idle");
      return;
    }
    const stored = window.localStorage.getItem(recoveryKey(address));
    if (!stored) return;
    let cancelled = false;
    void getBridgeIntent(stored, address)
      .then((view) => {
        if (cancelled || view.status === "completed") return;
        setIntent(view);
        setStage("recoverable_error");
        setError(
          "A previous bridge intent is still open. Review it before starting a new transfer.",
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [address]);

  const busy = stage !== "idle" && stage !== "completed";

  const amountUnits = useMemo(() => {
    try {
      return parseUsdc(amount);
    } catch {
      return null;
    }
  }, [amount]);

  const requestKey =
    amountUnits && amountUnits > 0n
      ? [source.code, destination.code, amountUnits.toString()].join("|")
      : null;

  useEffect(() => {
    queueMicrotask(() => {
      setQuote(null);
      setQuoteKey(null);
      setQuoteError(null);
    });
    if (!requestKey || !amountUnits) return;
    const controller = new AbortController();
    const sequence = ++quoteSequence.current;
    const timer = setTimeout(async () => {
      setQuoting(true);
      try {
        const next = await fetchBridgeQuote({
          sourceCode: source.code,
          destinationCode: destination.code,
          amount: amountUnits.toString(),
        });
        if (sequence !== quoteSequence.current || controller.signal.aborted)
          return;
        setQuote(next);
        setQuoteKey(requestKey);
        setQuoteError(null);
      } catch (cause) {
        if (controller.signal.aborted || sequence !== quoteSequence.current)
          return;
        setQuote(null);
        setQuoteKey(null);
        setQuoteError(
          cause instanceof Error ? cause.message : "Bridge quote failed.",
        );
      } finally {
        if (sequence === quoteSequence.current) setQuoting(false);
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [amountUnits, destination.code, requestKey, source.code]);

  const showQuoteSkeleton = useDelayedLoading(quoting);
  const quoteCurrent = Boolean(quote && requestKey && quoteKey === requestKey);
  const fastUnavailable =
    quoteError?.includes("temporarily unavailable") ?? false;

  async function ensureChain(targetChainId: number) {
    if (chainId !== targetChainId) {
      await switchChainAsync({ chainId: targetChainId });
    }
  }

  async function pollAttestation(view: BridgeIntentView, wallet: Address) {
    let lastDelayReason: string | null = null;
    for (let attempt = 0; attempt < ATTESTATION_MAX_ATTEMPTS; attempt += 1) {
      const refreshed = await getBridgeAttestation(view.id, wallet);
      setIntent(refreshed);
      if (refreshed.status === "attestation_ready") return refreshed;
      lastDelayReason = refreshed.result?.attestationDelayReason ?? null;
      if (lastDelayReason === "insufficient_fee") {
        throw new Error(
          "Circle reports insufficient Fast fee for this burn (maxFee below the required Fast fee). Do not submit another burn for this intent; it remains recoverable and no duplicate burn was created.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    if (lastDelayReason === "insufficient_fee") {
      throw new Error(
        "Circle reports insufficient Fast fee for this burn. Do not submit another burn for this intent.",
      );
    }
    throw new Error(
      "The Circle attestation is taking longer than expected. Keep this page open and check status again.",
    );
  }

  async function start() {
    bridgeCapability.assertEnabled();
    if (running.current || !address) return;
    running.current = true;
    setError(null);
    try {
      if (!isConnected) throw new Error("Connect an external wallet first.");
      const wallet = getAddress(address);
      // Fail closed before any burn: a current authoritative quote is
      // required. For Fast routes the backend verifies the live Circle fee
      // and allowance; when unavailable it fails with the fast-unavailable
      // message and no transaction is built.
      if (!quoteCurrent || !quote || !requestKey) {
        throw new Error(
          quoteError ?? "Wait for a current bridge quote before continuing.",
        );
      }
      const amountUnitsValue = parseUsdc(amount);
      const maxFeeUnits = BigInt(quote.maxFeeSuggested);
      if (maxFeeUnits > amountUnitsValue) {
        throw new Error(
          "Bridge quote is invalid for this amount. Wait for a new quote.",
        );
      }

      setStage("creating");
      const created = await createBridgeIntent({
        idempotencyKey: crypto.randomUUID(),
        sourceCode: source.code,
        destinationCode: destination.code,
        walletAddress: wallet,
        recipientAddress: wallet,
        amount: amountUnitsValue.toString(),
        maxFee: maxFeeUnits.toString(),
        minFinalityThreshold: quote.minFinalityThreshold,
      });
      setIntent(created);
      window.localStorage.setItem(recoveryKey(wallet), created.id);

      await ensureChain(sourceChain.id);
      setStage("approving");
      const approvalHash = await writeContractAsync({
        address: created.payload.sourceUsdcAddress,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [created.payload.sourceTokenMessengerV2, amountUnitsValue],
        account: wallet,
        chainId: sourceChain.id,
      });
      await sourcePublicClient?.waitForTransactionReceipt({
        hash: approvalHash,
      });
      const approved = await reportBridgeApproval(created.id, {
        walletAddress: wallet,
        transactionHash: approvalHash,
      });
      setIntent(approved);

      setStage("burning");
      const burnHash = await writeContractAsync({
        address: created.payload.sourceTokenMessengerV2,
        abi: CCTP_TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        args: [
          amountUnitsValue,
          created.payload.destinationDomain,
          addressToBytes32(wallet),
          created.payload.sourceUsdcAddress,
          addressToBytes32(created.payload.destinationCaller),
          maxFeeUnits,
          quote.minFinalityThreshold,
        ],
        account: wallet,
        chainId: sourceChain.id,
      });
      const sourced = await reportBridgeSource(approved.id, {
        walletAddress: wallet,
        transactionHash: burnHash,
      });
      setIntent(sourced);

      setStage("waiting_attestation");
      const attested = await pollAttestation(sourced, wallet);

      setStage("authorizing");
      const authorized = await authorizeBridgeDestination(attested.id, wallet);
      if (!authorized.destinationLeaseId) {
        throw new Error("Destination authorization did not return a lease.");
      }
      setIntent(authorized);

      await ensureChain(destinationChain.id);
      setStage("minting");
      if (
        !attested.result?.attestedMessage ||
        !attested.result?.attestation ||
        !attested.result?.messageHash
      ) {
        throw new Error("Circle attestation data is incomplete.");
      }
      const mintHash = await writeContractAsync({
        address: created.payload.destinationMessageTransmitterV2,
        abi: CCTP_MESSAGE_TRANSMITTER_ABI,
        functionName: "receiveMessage",
        args: [
          attested.result.attestedMessage as Hex,
          attested.result.attestation as Hex,
        ],
        account: wallet,
        chainId: destinationChain.id,
      });
      await destinationPublicClient?.waitForTransactionReceipt({
        hash: mintHash,
      });
      const submitted = await submitBridgeDestination(authorized.id, {
        walletAddress: wallet,
        transactionHash: mintHash,
        messageHash: attested.result.messageHash,
        leaseId: authorized.destinationLeaseId,
      });
      setIntent(submitted);

      setStage("verifying");
      const completed = await verifyBridgeDestination(submitted.id, wallet);
      setIntent(completed);
      setStage("completed");
      toast({
        title: "Bridge completed",
        description: `Native USDC arrived on ${destination.name} via official Circle CCTP.`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bridge failed.");
      setStage((previous) =>
        previous === "completed" ? previous : "recoverable_error",
      );
    } finally {
      running.current = false;
    }
  }

  async function checkStatus() {
    if (!intent || !address || checking) return;
    setChecking(true);
    try {
      const refreshed = await getBridgeAttestation(
        intent.id,
        getAddress(address),
      );
      setIntent(refreshed);
      setError(null);
      if (refreshed.status === "completed") setStage("completed");
      else if (refreshed.status === "attestation_ready") {
        setStage("recoverable_error");
        setError(
          "Attestation is ready. Start a new transfer only after completing the destination mint from the intent below.",
        );
      } else if (
        refreshed.status === "waiting_for_attestation" &&
        refreshed.result?.attestationDelayReason === "insufficient_fee"
      ) {
        setError(
          "Circle reports insufficient Fast fee for this burn (maxFee below the required Fast fee). Do not submit another burn for this intent.",
        );
      } else if (
        refreshed.status === "waiting_for_attestation" &&
        refreshed.result?.attestationStatus &&
        refreshed.result.attestationStatus !== "not_indexed"
      ) {
        setError(
          `Circle attestation status: ${refreshed.result.attestationStatus}. Keep this page open and check status again; no new burn is needed.`,
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Status check failed.",
      );
    } finally {
      setChecking(false);
    }
  }

  function startOver() {
    if (address) window.localStorage.removeItem(recoveryKey(address));
    setIntent(null);
    setError(null);
    setStage("idle");
  }

  const sourceTx = intent?.result?.sourceTransactionHash ?? null;
  const destTx = intent?.result?.destinationTransactionHash ?? null;
  const protocolFeeUnits = quoteCurrent && quote ? BigInt(quote.protocolFee) : null;
  const receiveUnits = quoteCurrent && quote ? BigInt(quote.receiveAmount) : null;
  const routeLabel =
    quoteCurrent && quote
      ? quote.transferMode === "fast"
        ? "Fast Circle CCTP"
        : "Circle CCTP"
      : null;
  const bridgeDisabled =
    busy ||
    !bridgeCapability.enabled ||
    !quoteCurrent ||
    !quote ||
    protocolFeeUnits === null ||
    receiveUnits === null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Bridge</h1>
        <p className="text-sm text-muted-foreground">
          Move native USDC between Arc Mainnet and supported chains with
          official Circle CCTP. Your wallet signs every transaction.
        </p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowLeftRight className="h-5 w-5 text-primary" />
              CCTP transfer
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
              <div className="space-y-2">
                <Label>From</Label>
                <Select
                  value={outbound ? "ARC-MAINNET" : counterparty}
                  onValueChange={(value) => {
                    if (value === "ARC-MAINNET") setOutbound(true);
                    else {
                      setOutbound(false);
                      setCounterparty(value);
                    }
                  }}
                  disabled={busy}
                >
                  <SelectTrigger aria-label="Source chain">
                    <SelectValue>
                      <BridgeChainLabel chainCode={source.code} />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ARC-MAINNET">
                      <BridgeChainLabel chainCode="ARC-MAINNET" />
                    </SelectItem>
                    {COUNTERPARTIES.map((code) => (
                      <SelectItem key={code} value={code}>
                        <BridgeChainLabel chainCode={code} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                size="icon"
                aria-label="Reverse direction"
                disabled={busy}
                onClick={() => setOutbound((value) => !value)}
              >
                <ArrowLeftRight className="h-4 w-4" />
              </Button>
              <div className="space-y-2">
                <Label>To</Label>
                <Select
                  value={outbound ? counterparty : "ARC-MAINNET"}
                  onValueChange={(value) => {
                    if (value === "ARC-MAINNET") setOutbound(false);
                    else {
                      setOutbound(true);
                      setCounterparty(value);
                    }
                  }}
                  disabled={busy}
                >
                  <SelectTrigger aria-label="Destination chain">
                    <SelectValue>
                      <BridgeChainLabel chainCode={destination.code} />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ARC-MAINNET">
                      <BridgeChainLabel chainCode="ARC-MAINNET" />
                    </SelectItem>
                    {COUNTERPARTIES.map((code) => (
                      <SelectItem key={code} value={code}>
                        <BridgeChainLabel chainCode={code} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bridge-amount">Amount (USDC)</Label>
              <Input
                id="bridge-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                disabled={busy}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div className="rounded-xl border border-border/30 bg-background/20 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Protocol fee</span>
                <span>
                  {showQuoteSkeleton
                    ? "Quoting…"
                    : protocolFeeUnits !== null
                      ? `${formatUsdcUnits(protocolFeeUnits)} USDC`
                      : "—"}
                </span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">You receive</span>
                <span>
                  {showQuoteSkeleton
                    ? "Quoting…"
                    : receiveUnits !== null
                      ? `${formatUsdcUnits(receiveUnits)} USDC`
                      : "—"}
                </span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Estimated route</span>
                <span>{routeLabel ?? "—"}</span>
              </div>
            </div>
            {quoteError ? (
              <div
                role="alert"
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
              >
                {fastUnavailable
                  ? BRIDGE_FAST_UNAVAILABLE_MESSAGE
                  : quoteError}
              </div>
            ) : null}
            {error ? (
              <div
                role="alert"
                className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {error}
              </div>
            ) : null}
            {stage !== "idle" && stage !== "completed" ? (
              <div
                role="status"
                className="rounded-xl border border-primary/25 bg-primary/10 p-4"
              >
                <p className="flex items-center gap-2 font-medium text-primary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {STAGE_COPY[stage]}
                </p>
                {intent ? (
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <p>Status: {intent.status.replaceAll("_", " ")}</p>
                    {sourceTx ? (
                      <p>
                        Source tx:{" "}
                        <a
                          className="text-primary hover:underline"
                          href={
                            explorerTxUrl(source, sourceTx) ?? "#"
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          {sourceTx.slice(0, 10)}...
                        </a>
                      </p>
                    ) : null}
                    {destTx ? (
                      <p>
                        Destination tx:{" "}
                        <a
                          className="text-primary hover:underline"
                          href={
                            explorerTxUrl(destination, destTx) ?? "#"
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          {destTx.slice(0, 10)}...
                        </a>
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {stage === "completed" ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
                <p className="flex items-center gap-2 font-semibold">
                  <ShieldCheck className="h-4 w-4" />
                  Native USDC bridged with Circle CCTP.
                </p>
                {destTx ? (
                  <a
                    className="mt-1 inline-block text-primary hover:underline"
                    href={explorerTxUrl(destination, destTx) ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View destination mint
                  </a>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                className="flex-1"
                disabled={bridgeDisabled}
                onClick={() => void start()}
              >
                {busy ? "Bridging..." : "Bridge USDC"}
              </Button>
              {intent && stage !== "idle" ? (
                <>
                  <Button
                    variant="outline"
                    disabled={checking}
                    onClick={() => void checkStatus()}
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${checking ? "animate-spin" : ""}`}
                    />
                    Check status
                  </Button>
                  <Button variant="ghost" onClick={startOver}>
                    Start over
                  </Button>
                </>
              ) : null}
            </div>
            {!bridgeCapability.enabled ? (
              <p role="alert" className="text-sm text-amber-300">
                {bridgeCapability.unavailableMessage}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card className="glass-card h-fit border-border/40">
          <CardHeader>
            <CardTitle className="text-base">Route details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              {source.name} (domain {source.domain}) → {destination.name}{" "}
              (domain {destination.domain})
            </p>
            <p>
              Circle CCTP settles in seconds on Arc and on Fast routes; other
              Standard routes settle after hard finality.
            </p>
            <p className="break-all font-mono text-xs">
              Messenger: {source.tokenMessengerV2}
            </p>
            <p>
              Single-transfer limit is $10M USDC. The fee is set by Circle at
              quote time against your quoted max fee.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
