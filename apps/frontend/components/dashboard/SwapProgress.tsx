"use client";

import {
  Check,
  Clock,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TokenSymbol } from "@/lib/wizpay";

export type SwapProgressRequestStatus =
  | "preparing"
  | "approving"
  | "signing"
  | "executing"
  | "confirming"
  | "completed";

type SwapStepId =
  | "preparing"
  | "approval"
  | "signing"
  | "executing"
  | "confirming"
  | "completed";
type StepState = "completed" | "active" | "pending" | "failed";

const STEP_COPY: Record<SwapStepId, { title: string; description: string }> = {
  preparing: {
    title: "Preparing swap",
    description: "Validating the quote, allowance, and Mainnet route.",
  },
  approval: {
    title: "Approval required",
    description: "Waiting for wallet approval to use the input token.",
  },
  signing: {
    title: "Signing transaction",
    description: "Review and confirm the swap in your external wallet.",
  },
  executing: {
    title: "Executing swap",
    description: "Submitting the confirmed swap on Arc Mainnet.",
  },
  confirming: {
    title: "Confirming on Arc Mainnet",
    description: "Waiting for on-chain confirmation and receipt verification.",
  },
  completed: {
    title: "Completed",
    description: "The confirmed output has been verified.",
  },
};

export function getSwapProgressModel({
  requestStatus,
  approvalRequired,
  failed,
}: {
  requestStatus: SwapProgressRequestStatus;
  approvalRequired: boolean | null;
  failed: boolean;
}) {
  const stepIds: SwapStepId[] = ["preparing"];
  if (approvalRequired === true) {
    stepIds.push("approval");
  }
  stepIds.push("signing", "executing", "confirming", "completed");

  const activeId: SwapStepId =
    requestStatus === "approving" ? "approval" : requestStatus;
  const activeIndex = Math.max(0, stepIds.indexOf(activeId));

  return stepIds.map((id, index) => ({
    id,
    ...STEP_COPY[id],
    state: (failed && index === activeIndex
      ? "failed"
      : index < activeIndex || activeId === "completed"
        ? "completed"
        : index === activeIndex
          ? "active"
          : "pending") as StepState,
  }));
}

export function SwapProgress({
  tokenIn,
  tokenOut,
  amount,
  requestStatus,
  approvalRequired,
  failure,
  onDismissFailure,
}: {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amount: string;
  requestStatus: SwapProgressRequestStatus;
  approvalRequired: boolean | null;
  failure: string | null;
  onDismissFailure: () => void;
}) {
  const steps = getSwapProgressModel({
    requestStatus,
    approvalRequired,
    failed: Boolean(failure),
  });
  const active = steps.find((step) =>
    failure ? step.state === "failed" : step.state === "active",
  );

  return (
    <section
      aria-label="Swap progress"
      aria-live="polite"
      className="overflow-hidden rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-500/10 via-indigo-500/5 to-background/30"
    >
      <div className="border-b border-violet-400/15 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1",
              failure
                ? "bg-destructive/10 text-destructive ring-destructive/25"
                : "bg-violet-500/15 text-violet-300 ring-violet-400/25",
            )}
          >
            {failure ? (
              <TriangleAlert className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-300/80">
              {failure ? "Swap stopped" : "Swap in progress"}
            </p>
            <h3 className="mt-1 break-words text-base font-semibold sm:text-lg">
              Swapping {tokenIn} <span aria-hidden="true">→</span> {tokenOut}
            </h3>
            <p className="mt-1 break-words text-sm leading-6 text-muted-foreground">
              {failure ?? active?.description}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4 sm:px-5">
        <dl className="grid min-w-0 gap-3 rounded-xl border border-border/30 bg-background/25 p-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Amount</dt>
            <dd className="mt-1 break-words font-medium">{amount} {tokenIn}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Wallet</dt>
            <dd className="mt-1 break-words font-medium">External Wallet</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Route</dt>
            <dd className="mt-1 break-words font-medium">Arc Mainnet · chain 5042</dd>
          </div>
        </dl>

        <ol className="grid gap-2 sm:grid-cols-2" aria-label="Transaction stages">
          {steps.map((step) => {
            const Icon =
              step.state === "completed"
                ? Check
                : step.state === "failed"
                  ? X
                  : step.state === "active"
                    ? Loader2
                    : Clock;
            return (
              <li
                key={step.id}
                data-state={step.state}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-xs",
                  step.state === "completed" &&
                    "border-emerald-500/25 bg-emerald-500/8 text-emerald-300",
                  step.state === "active" &&
                    "border-violet-400/30 bg-violet-500/10 text-violet-200",
                  step.state === "pending" &&
                    "border-border/30 bg-background/20 text-muted-foreground",
                  step.state === "failed" &&
                    "border-destructive/30 bg-destructive/8 text-destructive",
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    step.state === "active" && "animate-spin",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words leading-4">
                  {step.id === "approval" ? "Approving token" : step.title}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 px-3 py-2.5 text-xs leading-5 text-sky-100">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Keep this page open. Your external wallet remains fully interactive
            while WizPay tracks the verified Mainnet transaction state.
          </span>
        </div>

        {failure ? (
          <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onDismissFailure}>
            Review swap
          </Button>
        ) : null}
      </div>
    </section>
  );
}
