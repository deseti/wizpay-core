"use client";

import { ScanLine, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatCompactAddress,
  formatTokenAmount,
  SUPPORTED_TOKENS,
  TOKEN_OPTIONS,
} from "@/lib/wizpay";
import type { PreparedRecipient } from "@/lib/types";
import type { RecipientDraft, TokenSymbol } from "@/lib/wizpay";

interface RecipientMobileCardProps {
  recipient: PreparedRecipient;
  index: number;
  selectedToken: TokenSymbol;
  activeTokenDecimals: number;
  estimatedOut: bigint;
  diagnostic: string | null;
  errors: Record<string, string>;
  quoteLoading: boolean;
  quoteRefreshing: boolean;
  isBusy: boolean;
  recipientCount: number;
  updateRecipient: (
    id: string,
    field: keyof Omit<RecipientDraft, "id">,
    value: string,
  ) => void;
  removeRecipient: (id: string) => void;
  onScanRequest: (id: string) => void;
}

export function RecipientMobileCard({
  recipient,
  index,
  selectedToken,
  estimatedOut,
  diagnostic,
  errors,
  quoteLoading,
  quoteRefreshing,
  isBusy,
  recipientCount,
  updateRecipient,
  removeRecipient,
  onScanRequest,
}: RecipientMobileCardProps) {
  return (
    <Card className="surface-panel border border-border/40" size="sm">
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Recipient {index + 1}</CardTitle>
            <CardDescription>
              {recipient.targetToken === selectedToken
                ? "Direct payout"
                : "Official adapter payout"}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => removeRecipient(recipient.id)}
            disabled={recipientCount === 1 || isBusy}
            aria-label={`Remove recipient ${index + 1}`}
            className="hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Wallet Address / ANS Name</label>
          <div className="flex items-start gap-2">
            <Input
              placeholder="0x... or alice.arc"
              value={recipient.address}
              onChange={(e) =>
                updateRecipient(recipient.id, "address", e.target.value)
              }
              disabled={isBusy}
              className="h-11 flex-1 bg-background/50 font-mono text-xs border-border/40"
              aria-invalid={Boolean(errors[`${recipient.id}-address`])}
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => onScanRequest(recipient.id)}
              disabled={isBusy}
              aria-label={`Scan QR for recipient ${index + 1}`}
              className="mt-1 border-border/40"
            >
              <ScanLine className="h-4 w-4" />
            </Button>
          </div>
          {errors[`${recipient.id}-address`] ? (
            <p className="text-xs text-destructive">
              {errors[`${recipient.id}-address`]}
            </p>
          ) : recipient.recipientInputType === "ans" ? (
            recipient.resolutionState === "loading" ? (
              <p className="text-xs text-muted-foreground/70">
                Resolving {recipient.ansDomain ?? recipient.address}...
              </p>
            ) : recipient.normalizedAddress ? (
              <p className="text-xs text-emerald-300/80">
                Resolves to {formatCompactAddress(recipient.normalizedAddress)}
              </p>
            ) : recipient.resolutionError ? (
              <p className="text-xs text-destructive">
                {recipient.resolutionError}
              </p>
            ) : null
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Target Token</label>
            <Select
              value={recipient.targetToken}
              onValueChange={(value) =>
                updateRecipient(recipient.id, "targetToken", value)
              }
              disabled={isBusy}
            >
              <SelectTrigger className="h-11 bg-background/50 border-border/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOKEN_OPTIONS.map((token) => (
                  <SelectItem
                    key={`${recipient.id}-mobile-${token.symbol}`}
                    value={token.symbol}
                  >
                    {token.symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">You Send</label>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.000001"
              placeholder="0.00"
              value={recipient.amount}
              onChange={(e) =>
                updateRecipient(recipient.id, "amount", e.target.value)
              }
              disabled={isBusy}
              className="h-11 bg-background/50 tabular-nums border-border/40"
              aria-invalid={Boolean(errors[`${recipient.id}-amount`])}
            />
            {errors[`${recipient.id}-amount`] ? (
              <p className="text-xs text-destructive">
                {errors[`${recipient.id}-amount`]}
              </p>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-border/40 bg-background/35 px-3 py-2.5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground/60">
              They Receive
            </span>
            {quoteLoading ? (
              <Skeleton className="h-4 w-24 bg-muted/20" />
            ) : (
              <span className="font-mono text-sm font-medium">
                {formatTokenAmount(
                  estimatedOut,
                  SUPPORTED_TOKENS[recipient.targetToken].decimals,
                )}{" "}
                {recipient.targetToken}
              </span>
            )}
          </div>
          <p
            className={`mt-2 text-[11px] ${
              diagnostic ? "text-amber-300/80" : "text-muted-foreground/60"
            }`}
          >
            {diagnostic ??
              (quoteLoading
                ? "Loading quote..."
                : quoteRefreshing
                  ? "Refreshing quote..."
                  : recipient.targetToken === selectedToken
                    ? "Same-token payout."
                    : "Official adapter quote.")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
