"use client";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RECIPIENT_PREVIEW_LIMIT } from "@/lib/batch-csv";
import {
  formatCompactAddress,
  formatTokenAmount,
  SUPPORTED_TOKENS,
} from "@/lib/wizpay";
import type { PreparedRecipient, QuoteSummary } from "@/lib/types";
import type { TokenSymbol } from "@/lib/wizpay";

interface AllRecipientsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preparedRecipients: PreparedRecipient[];
  validRecipientCount: number;
  batchAmount: bigint;
  activeToken: { symbol: TokenSymbol; decimals: number };
  quoteSummary: QuoteSummary;
  quoteLoading: boolean;
  rowDiagnostics: (string | null)[];
  selectedToken: TokenSymbol;
}

export function AllRecipientsDialog({
  open,
  onOpenChange,
  preparedRecipients,
  validRecipientCount,
  batchAmount,
  activeToken,
  quoteSummary,
  quoteLoading,
  rowDiagnostics,
  selectedToken,
}: AllRecipientsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-4xl border-border/40 bg-background/95 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>All recipients</DialogTitle>
          <DialogDescription>
            Review the full batch here. The main composer only renders the first{" "}
            {RECIPIENT_PREVIEW_LIMIT} rows to keep the page responsive.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 px-6 md:grid-cols-3">
          <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
              Total recipients
            </p>
            <p className="mt-2 text-2xl font-semibold">
              {preparedRecipients.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              {validRecipientCount} ready to route
            </p>
          </div>
          <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
              Total amount
            </p>
            <p className="mt-2 text-2xl font-semibold font-mono">
              {formatTokenAmount(batchAmount, activeToken.decimals)}{" "}
              {activeToken.symbol}
            </p>
          </div>
          <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
              Estimated receive
            </p>
            {quoteLoading ? (
              <Skeleton className="mt-3 h-6 w-32 bg-muted/20" />
            ) : (
              <p className="mt-2 text-2xl font-semibold font-mono">
                {formatTokenAmount(
                  quoteSummary.totalEstimatedOut,
                  activeToken.decimals,
                )}
              </p>
            )}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 pb-6">
          <div className="space-y-3">
            {preparedRecipients.map((recipient, index) => {
              const estimatedOut =
                quoteSummary.estimatedAmountsOut[index] ?? 0n;
              const diagnostic = rowDiagnostics[index];
              const routeIsDirect = recipient.targetToken === selectedToken;

              return (
                <div
                  key={`review-${recipient.id}`}
                  className="rounded-2xl border border-border/40 bg-background/30 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
                        Recipient {index + 1}
                      </p>
                      <p className="font-mono text-xs break-all text-foreground/80">
                        {recipient.address || "Address not set"}
                      </p>
                      {recipient.recipientInputType === "ans" ? (
                        recipient.normalizedAddress ? (
                          <p className="text-xs text-emerald-300/80">
                            Resolves to {formatCompactAddress(recipient.normalizedAddress)}
                          </p>
                        ) : recipient.resolutionState === "loading" ? (
                          <p className="text-xs text-muted-foreground/65">
                            Resolving {recipient.ansDomain ?? recipient.address}...
                          </p>
                        ) : recipient.resolutionError ? (
                          <p className="text-xs text-destructive">
                            {recipient.resolutionError}
                          </p>
                        ) : null
                      ) : null}
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        routeIsDirect
                          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300/80"
                          : "border-amber-500/20 bg-amber-500/5 text-amber-300/80"
                      }
                    >
                      {routeIsDirect ? "Direct" : "Swap"}
                    </Badge>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                        You send
                      </p>
                      <p className="mt-1 font-mono text-sm text-foreground/80">
                        {recipient.amount || "-"} {activeToken.symbol}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                        They receive
                      </p>
                      {quoteLoading ? (
                        <Skeleton className="mt-2 h-4 w-24 bg-muted/20" />
                      ) : (
                        <p className="mt-1 font-mono text-sm text-foreground/80">
                          {formatTokenAmount(
                            estimatedOut,
                            SUPPORTED_TOKENS[recipient.targetToken].decimals,
                          )}{" "}
                          {recipient.targetToken}
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                        Token
                      </p>
                      <p className="mt-1 text-sm text-foreground/80">
                        {recipient.targetToken}
                      </p>
                    </div>
                  </div>

                  {diagnostic ? (
                    <p className="mt-3 text-xs text-amber-300/80">
                      {diagnostic}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
