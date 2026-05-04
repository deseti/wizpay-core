"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CircleTransfer } from "@/lib/transfer-service";
import {
  type BridgeStepId,
  type CircleTransferBlockchain,
} from "./bridge-types";
import {
  getOrderedBridgeSteps,
  getCurrentStepId,
  getTransferHeadline,
  getTransferStatusLabel,
  getStatusBadgeClass,
  getStepStatusLabel,
  getLongRunningTransferMessage,
  normalizeBridgeStepId,
  hasExplorerTxHash,
  shortenAddress,
  getLastUpdatedLabel,
  getOptionByChain,
} from "./bridge-utils";
import { BRIDGE_STUCK_TIMEOUT_MS, BRIDGE_LONG_RUNNING_MS } from "./bridge-types";

interface BridgeProgressCardProps {
  transfer: CircleTransfer;
  isPollingTransfer: boolean;
  isSubmitting: boolean;
  isReconnectingToTracking: boolean;
  estimatedTimeLabel: string;
  sourceOption: { id: CircleTransferBlockchain; label: string };
  destinationOption: { id: CircleTransferBlockchain; label: string };
  onDismiss: () => void;
  onRetryAttestation: () => void;
}

export function BridgeProgressCard({
  transfer,
  isPollingTransfer,
  isSubmitting,
  isReconnectingToTracking,
  estimatedTimeLabel,
  sourceOption,
  destinationOption,
  onDismiss,
  onRetryAttestation,
}: BridgeProgressCardProps) {
  const transferSourceOption = getOptionByChain(transfer.sourceBlockchain);
  const transferDestinationOption = getOptionByChain(transfer.blockchain);

  const orderedSteps = getOrderedBridgeSteps(
    transfer,
    transferSourceOption.label,
    transferDestinationOption.label
  );
  const currentStepId = getCurrentStepId(transfer, orderedSteps);
  const currentStep = orderedSteps.find(
    (step) => normalizeBridgeStepId(step.id) === currentStepId
  );

  const isTransferActive =
    transfer.status === "pending" || transfer.status === "processing";
  const isExternalBridgeTransfer = transfer.transferId?.startsWith("ext-") ?? false;

  const transferAgeMs = Date.now() - new Date(transfer.createdAt).getTime();
  const isTransferStuck =
    isTransferActive &&
    !isExternalBridgeTransfer &&
    transferAgeMs > BRIDGE_STUCK_TIMEOUT_MS;
  const shouldShowLongRunningMessage = Boolean(
    isTransferActive && transferAgeMs > BRIDGE_LONG_RUNNING_MS
  );
  const longRunningMessage = getLongRunningTransferMessage(
    transfer,
    currentStepId,
    {
      destinationLabel: transferDestinationOption.label,
      sourceLabel: transferSourceOption.label,
    }
  );

  const canDismissTransfer =
    !isSubmitting && transfer.status !== "settled";
  const canRetryExternalAttestation =
    isExternalBridgeTransfer &&
    Boolean(transfer.txHashBurn) &&
    !isSubmitting &&
    (transfer.rawStatus === "burned" ||
      transfer.rawStatus === "attesting" ||
      transfer.status === "failed");

  const burnStep = orderedSteps.find((s) => s.id === "burn");
  const mintStep = orderedSteps.find((s) => s.id === "mint");
  const burnExplorerUrl = hasExplorerTxHash(burnStep?.explorerUrl)
    ? burnStep?.explorerUrl
    : null;
  const mintExplorerUrl = hasExplorerTxHash(mintStep?.explorerUrl)
    ? mintStep?.explorerUrl
    : null;

  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary/80">
            Bridge progress
          </p>
          <h2 className="mt-2 text-lg font-semibold text-foreground">
            {getTransferHeadline(transfer, currentStep?.name)}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground/80">
            Estimated time {estimatedTimeLabel}. You can leave this page and
            tracking will resume when you return.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${getStatusBadgeClass(
              transfer
            )}`}
          >
            {isPollingTransfer && isTransferActive ? (
              <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : transfer.status === "settled" ? (
              <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
            ) : transfer.status === "failed" ? (
              <AlertTriangle className="mr-2 h-3.5 w-3.5" />
            ) : (
              <Clock3 className="mr-2 h-3.5 w-3.5" />
            )}
            {getTransferStatusLabel(transfer)}
          </div>
          {canDismissTransfer ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs"
              onClick={onDismiss}
              disabled={isSubmitting}
            >
              Start new bridge
            </Button>
          ) : null}
        </div>
      </div>

      {shouldShowLongRunningMessage ? (
        <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {longRunningMessage}
        </div>
      ) : null}

      {isTransferStuck ? (
        <div className="mt-4 rounded-2xl border border-destructive/25 bg-destructive/5 p-4">
          <p className="text-sm font-semibold text-destructive">
            Transfer has been processing for over 15 minutes
          </p>
          <p className="mt-1 text-sm text-destructive/80">
            The Circle bridge did not complete within the expected time. This is
            likely a testnet congestion or attestation failure. You can safely
            dismiss this and start a new bridge.
          </p>
          {canRetryExternalAttestation ? (
            <Button
              size="sm"
              className="mt-3"
              onClick={onRetryAttestation}
              disabled={isSubmitting}
            >
              Retry attestation and destination mint
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="destructive"
            className="mt-3 ml-2"
            onClick={onDismiss}
          >
            Dismiss and start new bridge
          </Button>
        </div>
      ) : isReconnectingToTracking ? (
        <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Reconnecting to tracking... Redis cache was cleared or rotated, so
          WizPay is retrying from durable bridge history until this transfer
          reaches a final state.
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {orderedSteps.map((step) => {
          const stepId = normalizeBridgeStepId(step.id);
          const isCurrentStep =
            Boolean(stepId && currentStepId && stepId === currentStepId) &&
            isTransferActive;
          const statusLabel = getStepStatusLabel(
            step,
            currentStepId,
            transfer.status
          );

          return (
            <div
              key={`${transfer.transferId}-${step.id}`}
              className={`rounded-2xl border p-4 ${
                step.state === "success"
                  ? "border-emerald-500/25 bg-emerald-500/5"
                  : step.state === "error"
                    ? "border-destructive/25 bg-destructive/5"
                    : isCurrentStep
                      ? "border-primary/25 bg-primary/5"
                      : "border-border/30 bg-background/40"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl ${
                      step.state === "success"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : step.state === "error"
                          ? "bg-destructive/10 text-destructive"
                          : isCurrentStep
                            ? "bg-primary/15 text-primary"
                            : "bg-background/60 text-muted-foreground/70"
                    }`}
                  >
                    {step.state === "success" ? (
                      <CheckCircle2 className="h-4.5 w-4.5" />
                    ) : step.state === "error" ? (
                      <AlertTriangle className="h-4.5 w-4.5" />
                    ) : isCurrentStep ? (
                      <RefreshCw className="h-4.5 w-4.5 animate-spin" />
                    ) : (
                      <Clock3 className="h-4.5 w-4.5" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{step.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      {statusLabel}
                    </p>
                    {step.txHash ? (
                      <p className="mt-2 font-mono text-xs text-muted-foreground/80">
                        {shortenAddress(step.txHash)}
                      </p>
                    ) : null}
                    {step.errorMessage ? (
                      <p className="mt-2 text-xs text-destructive">
                        {step.errorMessage}
                      </p>
                    ) : null}
                  </div>
                </div>
                {step.explorerUrl ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={step.explorerUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      View tx
                    </a>
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/30 bg-background/40 p-4 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
            Transfer ID
          </p>
          <p className="mt-2 font-mono text-xs text-muted-foreground/80">
            {transfer.transferId}
          </p>
        </div>
        <div className="rounded-2xl border border-border/30 bg-background/40 p-4 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
            Route
          </p>
          <p className="mt-2 font-medium text-foreground">
            {transferSourceOption.label} to {transferDestinationOption.label}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Last updated {getLastUpdatedLabel(transfer.updatedAt)}
          </p>
        </div>
      </div>
    </div>
  );
}
