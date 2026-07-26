"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AppWalletSwapOperationResponse } from "@/lib/app-wallet-swap-service";
import { formatUserSwapQuoteAmount } from "@/lib/user-swap-quote-parser";
import { EXPLORER_BASE_URL } from "@/lib/wizpay";

import {
  canExecuteAppWalletOperation,
  canRequestAppWalletRefund,
  getAppWalletOperationMessage,
  getAppWalletSwapPhase,
  getOperationExpectedOutput,
  getPhaseDescription,
  getPhaseTitle,
  getRefundActionLabel,
  isAppWalletRefundStatus,
} from "./app-wallet-swap-view-model";
import type { SwapRequestStatus } from "./use-app-wallet-swap-operation";

const APP_WALLET_SWAP_PROVIDER_LABELS = {
  stablefx: "StableFX",
  swapkit: "SwapKit",
} as const;

interface AppWalletSwapProgressProps {
  isCircleWalletMode: boolean;
  isGuarded: boolean;
  isOpen: boolean;
  isRefundConfirmationOpen: boolean;
  onCopy: (value: string, label: string) => void;
  onExecute: () => void;
  onOpenChange: (open: boolean) => void;
  onRefund: () => void;
  onRefundConfirmationOpenChange: (open: boolean) => void;
  onReset: () => void;
  onSubmitDeposit: () => void;
  operation: AppWalletSwapOperationResponse | null;
  requestStatus: SwapRequestStatus;
}

function ProgressStep({
  label,
  status,
}: {
  label: string;
  status: "pending" | "active" | "done";
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <div
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          status === "done"
            ? "bg-emerald-500/20 text-emerald-400"
            : status === "active"
              ? "bg-sky-500/20 text-sky-300"
              : "bg-muted/20 text-muted-foreground/40"
        }`}
      >
        {status === "done" ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : status === "active" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <div className="h-1.5 w-1.5 rounded-full bg-current" />
        )}
      </div>
      <span
        className={
          status === "done"
            ? "text-emerald-400"
            : status === "active"
              ? "font-medium text-foreground"
              : "text-muted-foreground/50"
        }
      >
        {label}
      </span>
    </div>
  );
}

function DetailRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted-foreground/60">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 break-all text-right text-foreground/80">
          {value}
        </span>
        {onCopy ? (
          <button
            type="button"
            onClick={onCopy}
            className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground/70"
          >
            <Copy className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function AppWalletSwapProgress({
  isCircleWalletMode,
  isGuarded,
  isOpen,
  isRefundConfirmationOpen,
  onCopy,
  onExecute,
  onOpenChange,
  onRefund,
  onRefundConfirmationOpenChange,
  onReset,
  onSubmitDeposit,
  operation,
  requestStatus,
}: AppWalletSwapProgressProps) {
  const [advancedDetailsOpen, setAdvancedDetailsOpen] = useState(false);
  const phase = getAppWalletSwapPhase(operation);
  const isRefundFlow = operation
    ? isAppWalletRefundStatus(operation.status)
    : false;
  const isRefundInProgress =
    operation?.status === "refund_pending" ||
    operation?.status === "refund_submitted";
  const isInProgress =
    phase === "processing_swap" ||
    phase === "receiving_payout" ||
    isRefundInProgress;
  const isComplete = phase === "completed";
  const isRefunded = phase === "refunded";
  const isTerminalComplete = isComplete || isRefunded;
  const isFailed = phase === "failed";
  const showOperationError =
    Boolean(operation?.executionError) &&
    (isFailed || operation?.status === "execution_recovery_required");
  const refundActionAvailable = Boolean(
    operation &&
      isCircleWalletMode &&
      canRequestAppWalletRefund(operation),
  );

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="glass-card max-w-lg overflow-hidden border-border/40 bg-background/95 p-0">
          <div className="relative overflow-hidden p-6">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-400/40 to-transparent" />
            {operation ? (
              <div className="space-y-5">
                <div
                  className={`flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ${
                    isComplete
                      ? "bg-emerald-500/12 text-emerald-400 ring-emerald-400/20"
                      : isRefunded
                        ? "bg-emerald-500/12 text-emerald-400 ring-emerald-400/20"
                        : isFailed
                          ? "bg-red-500/12 text-red-400 ring-red-400/20"
                          : "bg-sky-500/12 text-sky-300 ring-sky-400/20"
                  }`}
                >
                  {isTerminalComplete ? (
                    <CheckCircle2 className="h-7 w-7" />
                  ) : isInProgress ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : (
                    <Clock3 className="h-7 w-7" />
                  )}
                </div>

                <DialogHeader className="space-y-2">
                  <DialogTitle className="text-xl">
                    {getPhaseTitle(phase)}
                  </DialogTitle>
                  <DialogDescription>
                    {getPhaseDescription(phase, operation)}
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-2">
                  {isRefundFlow ? (
                    <>
                      <ProgressStep
                        label="Recovery available"
                        status={
                          operation.status === "execution_recovery_required"
                            ? "active"
                            : "done"
                        }
                      />
                      <ProgressStep
                        label="Refund submitted"
                        status={
                          operation.status === "refund_pending"
                            ? "active"
                            : operation.status ===
                                "execution_recovery_required"
                              ? "pending"
                              : "done"
                        }
                      />
                      <ProgressStep
                        label="Refund confirmed"
                        status={
                          operation.status === "refunded"
                            ? "done"
                            : operation.status === "refund_submitted"
                              ? "active"
                              : "pending"
                        }
                      />
                    </>
                  ) : (
                    <>
                      <ProgressStep
                        label="Confirm deposit"
                        status={
                          phase === "confirm_deposit" ? "active" : "done"
                        }
                      />
                      <ProgressStep
                        label="Processing swap"
                        status={
                          phase === "processing_swap"
                            ? "active"
                            : phase === "confirm_deposit"
                              ? "pending"
                              : "done"
                        }
                      />
                      <ProgressStep
                        label="Sending funds to your wallet"
                        status={
                          phase === "receiving_payout"
                            ? "active"
                            : phase === "completed"
                              ? "done"
                              : "pending"
                        }
                      />
                      <ProgressStep
                        label="Completed"
                        status={phase === "completed" ? "done" : "pending"}
                      />
                    </>
                  )}
                </div>

                <div className="space-y-2 rounded-xl border border-border/40 bg-background/45 p-4 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground/70">Swap</span>
                    <span className="font-medium">
                      {formatUserSwapQuoteAmount(
                        operation.amountIn,
                        operation.tokenIn,
                      ) ?? `${operation.amountIn} ${operation.tokenIn}`}
                      {" → "}
                      {operation.tokenOut}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground/70">Provider</span>
                    <span className="font-medium">
                      {operation.provider
                        ? APP_WALLET_SWAP_PROVIDER_LABELS[operation.provider]
                        : "Unavailable"}
                    </span>
                  </div>
                  {operation.payoutAmount ||
                  operation.treasurySwapActualOutput ? (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground/70">Received</span>
                      <span className="font-mono font-medium text-emerald-400">
                        {formatUserSwapQuoteAmount(
                          operation.payoutAmount ??
                            operation.treasurySwapActualOutput,
                          operation.tokenOut,
                        )}
                      </span>
                    </div>
                  ) : getOperationExpectedOutput(operation) ? (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground/70">Expected</span>
                      <span className="font-mono font-medium">
                        {getOperationExpectedOutput(operation)}
                      </span>
                    </div>
                  ) : null}
                  {operation.refundAmount ? (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground/70">
                        Refund amount
                      </span>
                      <span className="font-mono font-medium">
                        {formatUserSwapQuoteAmount(
                          operation.refundAmount,
                          operation.tokenIn,
                        )}
                      </span>
                    </div>
                  ) : null}
                  {isRefundFlow ? (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground/70">
                        Refund status
                      </span>
                      <span className="font-mono font-medium">
                        {operation.status}
                      </span>
                    </div>
                  ) : null}
                </div>

                {showOperationError && operation.executionError ? (
                  <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-4 py-3 text-sm text-red-200">
                    {operation.executionError}
                  </div>
                ) : null}

                {isInProgress ? (
                  <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-sm text-sky-100">
                    {isRefundFlow
                      ? getAppWalletOperationMessage(operation)
                      : operation.status === "deposit_submitted" &&
                          !operation.depositTxHash
                        ? "Deposit received. Waiting for network confirmation."
                        : operation.status === "payout_pending" ||
                            operation.status === "treasury_swap_confirmed"
                          ? "Final wallet transfer is being confirmed."
                          : "WizPay is securely settling your swap. This can take a few minutes."}
                  </div>
                ) : null}

                <div className="flex flex-col gap-3 sm:flex-row">
                  {phase === "confirm_deposit" ? (
                    <Button
                      className="glow-btn flex-1 bg-gradient-to-r from-primary to-violet-500 text-primary-foreground"
                      onClick={onSubmitDeposit}
                      disabled={requestStatus === "depositing"}
                    >
                      {requestStatus === "depositing" ? (
                        <span className="flex items-center gap-2">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          Waiting for confirmation...
                        </span>
                      ) : (
                        "Confirm swap"
                      )}
                    </Button>
                  ) : null}
                  {isInProgress && !isRefundFlow ? (
                    <Button className="flex-1" disabled>
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Processing swap...
                      </span>
                    </Button>
                  ) : null}
                  {phase === "receiving_payout" ? (
                    <Button className="flex-1" disabled>
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Sending funds to your wallet...
                      </span>
                    </Button>
                  ) : null}
                  {isTerminalComplete ? (
                    <Button
                      className="flex-1"
                      onClick={() => {
                        onOpenChange(false);
                        onReset();
                      }}
                    >
                      Done
                    </Button>
                  ) : null}
                  {isFailed && canExecuteAppWalletOperation(operation) ? (
                    <Button
                      className="flex-1"
                      onClick={onExecute}
                      disabled={requestStatus === "executing"}
                    >
                      {requestStatus === "executing" ? (
                        <span className="flex items-center gap-2">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          Retrying...
                        </span>
                      ) : (
                        "Retry status check"
                      )}
                    </Button>
                  ) : null}
                  {refundActionAvailable ? (
                    <Button
                      className="flex-1"
                      variant="outline"
                      onClick={() => onRefundConfirmationOpenChange(true)}
                      disabled={requestStatus === "refunding" || isGuarded}
                    >
                      {requestStatus === "refunding"
                        ? "Refund request pending..."
                        : getRefundActionLabel(operation.status)}
                    </Button>
                  ) : null}
                  {operation.payoutTxHash ? (
                    <Button asChild variant="outline" className="flex-1">
                      <a
                        href={`${EXPLORER_BASE_URL}/tx/${operation.payoutTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View transaction
                      </a>
                    </Button>
                  ) : null}
                  {operation.refundTxHash ? (
                    <Button asChild variant="outline" className="flex-1">
                      <a
                        href={`${EXPLORER_BASE_URL}/tx/${operation.refundTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View refund transaction
                      </a>
                    </Button>
                  ) : null}
                  {!isTerminalComplete &&
                  !isFailed &&
                  phase !== "confirm_deposit" ? null : (
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => onOpenChange(false)}
                    >
                      Close
                    </Button>
                  )}
                </div>

                <div className="border-t border-border/30 pt-3">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground/80"
                    onClick={() =>
                      setAdvancedDetailsOpen(!advancedDetailsOpen)
                    }
                  >
                    {advancedDetailsOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    Advanced details
                  </button>
                  {advancedDetailsOpen ? (
                    <div className="mt-3 space-y-2 rounded-xl border border-border/30 bg-background/30 p-3 font-mono text-xs">
                      <DetailRow
                        label="Operation ID"
                        value={operation.operationId}
                        onCopy={() =>
                          onCopy(operation.operationId, "operation ID")
                        }
                      />
                      <DetailRow
                        label="Internal status"
                        value={operation.status}
                      />
                      {operation.refundTransactionId ? (
                        <DetailRow
                          label="Refund transaction"
                          value={operation.refundTransactionId}
                        />
                      ) : null}
                      {operation.refundTxHash ? (
                        <DetailRow
                          label="Refund txHash"
                          value={operation.refundTxHash}
                        />
                      ) : null}
                      {operation.refundSubmittedAt ? (
                        <DetailRow
                          label="Refund submitted"
                          value={operation.refundSubmittedAt}
                        />
                      ) : null}
                      {operation.refundConfirmedAt ? (
                        <DetailRow
                          label="Refund confirmed"
                          value={operation.refundConfirmedAt}
                        />
                      ) : null}
                      {operation.depositTxHash ? (
                        <DetailRow
                          label="Deposit txHash"
                          value={operation.depositTxHash}
                        />
                      ) : null}
                      {operation.treasurySwapTxHash ? (
                        <DetailRow
                          label="Settlement txHash"
                          value={operation.treasurySwapTxHash}
                        />
                      ) : null}
                      {operation.payoutTxHash ? (
                        <DetailRow
                          label="Payout txHash"
                          value={operation.payoutTxHash}
                        />
                      ) : null}
                      {operation.circleTransactionId ? (
                        <DetailRow
                          label="Circle transaction"
                          value={operation.circleTransactionId}
                        />
                      ) : null}
                      {operation.circleReferenceId ? (
                        <DetailRow
                          label="Circle reference"
                          value={operation.circleReferenceId}
                        />
                      ) : null}
                      {operation.executionError ? (
                        <DetailRow
                          label="Error"
                          value={operation.executionError}
                        />
                      ) : null}
                      {operation.depositConfirmationError ? (
                        <DetailRow
                          label="Deposit note"
                          value={operation.depositConfirmationError}
                        />
                      ) : null}
                      <DetailRow
                        label="Settlement address"
                        value={operation.treasuryDepositAddress}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isRefundConfirmationOpen}
        onOpenChange={(open) => {
          if (requestStatus !== "refunding") {
            onRefundConfirmationOpenChange(open);
          }
        }}
      >
        <DialogContent className="glass-card max-w-md border-border/40 bg-background/95">
          <DialogHeader>
            <DialogTitle>Request deposit refund recovery?</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                WizPay will ask the backend to recover the verified deposited
                amount.
              </span>
              <span className="block">
                Availability depends on backend and provider settlement safety.
                This request does not mean the refund is immediately confirmed.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={() => onRefundConfirmationOpenChange(false)}
              disabled={requestStatus === "refunding"}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onRefund}
              disabled={
                requestStatus === "refunding" ||
                isGuarded ||
                !operation ||
                !isCircleWalletMode ||
                !canRequestAppWalletRefund(operation)
              }
            >
              {requestStatus === "refunding"
                ? "Request pending..."
                : operation
                  ? getRefundActionLabel(operation.status)
                  : "Request refund"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
