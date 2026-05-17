"use client";

import { ScanLine, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  formatCompactAddress,
  formatTokenAmount,
  SUPPORTED_TOKENS,
  TOKEN_OPTIONS,
} from "@/lib/wizpay";
import type { PreparedRecipient } from "@/lib/types";
import type { RecipientDraft, TokenSymbol } from "@/lib/wizpay";

interface RecipientRowProps {
  recipient: PreparedRecipient;
  index: number;
  selectedToken: TokenSymbol;
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

export function RecipientRow({
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
}: RecipientRowProps) {
  const routeIsDirect = recipient.targetToken === selectedToken;

  return (
    <TableRow className="align-top border-border/20 hover:bg-primary/3 transition-colors">
      <TableCell className="pt-3 font-mono text-xs text-muted-foreground/60">
        {index + 1}
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <div className="flex items-start gap-2">
            <Input
              placeholder="0x... or alice.arc"
              value={recipient.address}
              onChange={(e) =>
                updateRecipient(recipient.id, "address", e.target.value)
              }
              disabled={isBusy}
              className="h-10 flex-1 bg-background/50 font-mono text-xs border-border/40"
              aria-invalid={Boolean(errors[`${recipient.id}-address`])}
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => onScanRequest(recipient.id)}
              disabled={isBusy}
              aria-label={`Scan QR for recipient ${index + 1}`}
              className="mt-0.5 border-border/40"
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
      </TableCell>
      <TableCell>
        <Select
          value={recipient.targetToken}
          onValueChange={(value) =>
            updateRecipient(recipient.id, "targetToken", value)
          }
          disabled={isBusy}
        >
          <SelectTrigger className="h-10 bg-background/50 border-border/40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TOKEN_OPTIONS.map((token) => (
              <SelectItem
                key={`${recipient.id}-${token.symbol}`}
                value={token.symbol}
              >
                {token.symbol}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
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
            className="h-10 bg-background/50 tabular-nums border-border/40"
            aria-invalid={Boolean(errors[`${recipient.id}-amount`])}
          />
          {errors[`${recipient.id}-amount`] ? (
            <p className="text-xs text-destructive">
              {errors[`${recipient.id}-amount`]}
            </p>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          {quoteLoading ? (
            <Skeleton className="h-4 w-24 bg-muted/20" />
          ) : (
            <p className="font-mono text-sm">
              {formatTokenAmount(
                estimatedOut,
                SUPPORTED_TOKENS[recipient.targetToken].decimals,
              )}{" "}
              {recipient.targetToken}
            </p>
          )}
          {diagnostic ? (
            <p className="text-xs text-amber-300/80">{diagnostic}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground/60">
              {quoteLoading
                ? "Loading quote..."
                : quoteRefreshing
                  ? "Refreshing quote..."
                  : routeIsDirect
                    ? "Same-token payout"
                    : "Official adapter quote"}
            </p>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={
            routeIsDirect
              ? "border-emerald-500/20 text-emerald-300/80 bg-emerald-500/5"
              : "border-amber-500/20 text-amber-300/80 bg-amber-500/5"
          }
        >
          {routeIsDirect ? "Direct" : "Official adapter"}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => removeRecipient(recipient.id)}
          disabled={recipientCount === 1 || isBusy}
          aria-label={`Remove recipient ${index + 1}`}
          className="hover:bg-red-500/10 hover:text-red-400 transition-colors"
        >
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
