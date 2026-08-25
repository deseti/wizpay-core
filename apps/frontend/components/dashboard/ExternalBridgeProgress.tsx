"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Circle,
  Clock3,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type BridgeProgressStage =
  | "confirming_source_burn"
  | "waiting_for_attestation"
  | "attestation_ready"
  | "switching_destination_chain"
  | "awaiting_mint_signature"
  | "confirming_destination_mint"
  | "verifying_completion";

export type BridgeProgressCondition = {
  tone: "retryable" | "failed";
  message: string;
} | null;

const STAGE_COPY: Record<
  BridgeProgressStage,
  { title: string; description: (destinationNetwork: string) => string }
> = {
  confirming_source_burn: {
    title: "Confirming source transaction",
    description: () =>
      "Your wallet submitted the source transaction. WizPay is waiting for network confirmation.",
  },
  waiting_for_attestation: {
    title: "Waiting for Circle attestation",
    description: () =>
      "Your source burn is confirmed. Circle is preparing the attestation required to mint USDC on the destination network.",
  },
  attestation_ready: {
    title: "Attestation ready",
    description: () =>
      "Circle has verified the source burn. WizPay is preparing the destination mint.",
  },
  switching_destination_chain: {
    title: "Switch network to continue",
    description: (destinationNetwork) =>
      `Switch your wallet to ${destinationNetwork} to authorize the destination mint.`,
  },
  awaiting_mint_signature: {
    title: "Confirm destination mint",
    description: () =>
      "Review and confirm the receiveMessage transaction in your wallet.",
  },
  confirming_destination_mint: {
    title: "Confirming destination transaction",
    description: () =>
      "The destination transaction was submitted and is waiting for network confirmation.",
  },
  verifying_completion: {
    title: "Verifying destination mint",
    description: () =>
      "The transaction is confirmed. WizPay is verifying the CCTP message, nonce, recipient, and USDC mint.",
  },
};

type StepState = "completed" | "active" | "pending" | "failed";

function getStepStates(
  stage: BridgeProgressStage,
  failed: boolean,
): StepState[] {
  const activeIndex =
    stage === "confirming_source_burn"
      ? 0
      : stage === "waiting_for_attestation"
        ? 1
        : stage === "attestation_ready" ||
            stage === "switching_destination_chain" ||
            stage === "awaiting_mint_signature"
          ? 2
          : 3;

  return [0, 1, 2, 3].map((index) => {
    if (failed && index === activeIndex) return "failed";
    if (index < activeIndex) return "completed";
    if (index === activeIndex) return "active";
    return "pending";
  });
}

function formatElapsed(createdAt: string, now: number) {
  const startedAt = Date.parse(createdAt);
  const elapsedSeconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((now - startedAt) / 1_000))
    : 0;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function truncateHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

export function ExternalBridgeProgress({
  stage,
  sourceNetwork,
  destinationNetwork,
  amount,
  token,
  sourceTransactionHash,
  sourceTransactionUrl,
  createdAt,
  condition,
  canCheckStatus,
  checkingStatus,
  manualCheckAvailableInSeconds,
  onCheckStatus,
  action,
}: {
  stage: BridgeProgressStage;
  sourceNetwork: string;
  destinationNetwork: string;
  amount: string | null;
  token: string;
  sourceTransactionHash: string;
  sourceTransactionUrl: string;
  createdAt: string;
  condition: BridgeProgressCondition;
  canCheckStatus: boolean;
  checkingStatus: boolean;
  manualCheckAvailableInSeconds: number;
  onCheckStatus: () => void;
  action?: React.ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const copy = STAGE_COPY[stage];
  const steps = useMemo(
    () => getStepStates(stage, condition?.tone === "failed"),
    [condition?.tone, stage],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  async function copySourceHash() {
    await navigator.clipboard.writeText(sourceTransactionHash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  }

  return (
    <section
      aria-label="Bridge in progress"
      className="overflow-hidden rounded-2xl border border-indigo-400/25 bg-gradient-to-br from-indigo-500/10 via-blue-500/5 to-background/30"
    >
      <div className="border-b border-indigo-400/15 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-400/25">
              <span className="absolute inset-0 animate-ping rounded-xl bg-indigo-400/10" />
              <LoaderCircle className="relative h-5 w-5 animate-spin" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-indigo-300/80">
                Bridge in progress
              </p>
              <h3 className="mt-1 text-base font-semibold text-foreground sm:text-lg">
                {copy.title}
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {copy.description(destinationNetwork)}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-indigo-400/20 bg-background/35 px-3 py-1.5 text-xs text-indigo-200">
            <Clock3 className="h-3.5 w-3.5" />
            <span aria-label="Elapsed processing time">
              {formatElapsed(createdAt, now)} elapsed
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="grid gap-3 rounded-xl border border-border/30 bg-background/25 p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Route</p>
            <p className="mt-1 font-medium">
              {sourceNetwork} <span aria-hidden="true">→</span>{" "}
              {destinationNetwork}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Immutable amount</p>
            <p className="mt-1 font-medium">
              {amount ? `${amount} ${token}` : `${token} amount recovering`}
            </p>
          </div>
        </div>

        <ol className="grid gap-2 sm:grid-cols-4" aria-label="Bridge progress">
          {[
            "Source burn confirmed",
            "Circle attestation",
            "Destination authorization",
            "Destination mint confirmed",
          ].map((label, index) => {
            const state = steps[index];
            const Icon =
              state === "completed"
                ? Check
                : state === "failed"
                  ? X
                  : state === "active"
                    ? LoaderCircle
                    : Circle;
            return (
              <li
                key={label}
                data-state={state}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-xs sm:flex-col sm:items-start",
                  state === "completed" &&
                    "border-emerald-500/25 bg-emerald-500/8 text-emerald-300",
                  state === "active" &&
                    "border-indigo-400/30 bg-indigo-500/10 text-indigo-200",
                  state === "pending" &&
                    "border-border/30 bg-background/20 text-muted-foreground",
                  state === "failed" &&
                    "border-destructive/30 bg-destructive/8 text-destructive",
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    state === "active" && "animate-spin",
                  )}
                />
                <span className="leading-4">{label}</span>
              </li>
            );
          })}
        </ol>

        {stage === "waiting_for_attestation" ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Processing time varies by source-network finality and network
            conditions. No completion time is promised.
          </p>
        ) : null}

        {condition ? (
          <div
            role={condition.tone === "failed" ? "alert" : "status"}
            className={cn(
              "flex gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5",
              condition.tone === "failed"
                ? "border-destructive/30 bg-destructive/8 text-destructive"
                : "border-amber-500/25 bg-amber-500/8 text-amber-200",
            )}
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{condition.message}</span>
          </div>
        ) : null}

        <div className="rounded-xl border border-blue-400/20 bg-blue-500/5 px-3 py-3 text-xs leading-5 text-blue-100/85">
          <div className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
            <p>
              The confirmed source burn is saved and will not be repeated. You
              can safely leave this page and recover the transfer later using
              the source transaction hash.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className="truncate" title={sourceTransactionHash}>
              {truncateHash(sourceTransactionHash)}
            </span>
            <button
              type="button"
              onClick={() => void copySourceHash()}
              className="shrink-0 rounded p-1 hover:bg-primary/10 hover:text-primary"
              aria-label="Copy source burn transaction hash"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <a
              href={sourceTransactionUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded p-1 hover:bg-primary/10 hover:text-primary"
              aria-label="View source burn on explorer"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start text-xs text-muted-foreground"
            disabled={!canCheckStatus || checkingStatus}
            onClick={onCheckStatus}
          >
            <RefreshCw
              className={cn("mr-1.5 h-3.5 w-3.5", checkingStatus && "animate-spin")}
            />
            {checkingStatus
              ? "Checking status"
              : manualCheckAvailableInSeconds > 0
                ? `Check again in ${manualCheckAvailableInSeconds}s`
                : "Check status now"}
          </Button>
        </div>

        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </section>
  );
}
