"use client";

import type { ReactNode } from "react";
import { CircleCheckBig, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface TransactionSuccessRow {
  label: string;
  value: ReactNode;
}

export interface TransactionSuccessDialogProps {
  open: boolean;
  title: string;
  description: string;
  rows: readonly TransactionSuccessRow[];
  transactionHash?: string;
  explorerUrl?: string;
  primaryTransactionLabel?: string;
  secondaryTransaction?: { label: string; explorerUrl: string };
  onDone: () => void;
  onStartAnother: () => void;
  startAnotherLabel: string;
}

function explorerAction(href: string) {
  return (
    <a
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      View on explorer <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

export function TransactionSuccessDialog({
  open,
  title,
  description,
  rows,
  transactionHash,
  explorerUrl,
  primaryTransactionLabel = "Transaction",
  secondaryTransaction,
  onDone,
  onStartAnother,
  startAnotherLabel,
}: TransactionSuccessDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onDone()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="items-center text-center">
          <div className="mb-1 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
            <CircleCheckBig className="h-8 w-8" aria-hidden="true" />
          </div>
          <DialogTitle className="text-xl">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-xl border border-border/40 bg-background/30 p-4">
          {rows.map((row) => (
            <div
              className="flex flex-col justify-between gap-1 sm:flex-row sm:gap-4"
              key={row.label}
            >
              <span className="text-muted-foreground">{row.label}</span>
              <span className="text-left font-medium sm:text-right">
                {row.value}
              </span>
            </div>
          ))}
          {transactionHash ? (
            <div className="space-y-1 border-t border-border/40 pt-3">
              <span className="text-muted-foreground">Transaction hash</span>
              <p className="break-all font-mono text-xs">{transactionHash}</p>
            </div>
          ) : null}
          {explorerUrl ? (
            <div className="flex items-center justify-between gap-4 border-t border-border/40 pt-3">
              <span>{primaryTransactionLabel}</span>
              {explorerAction(explorerUrl)}
            </div>
          ) : null}
          {secondaryTransaction ? (
            <div className="flex items-center justify-between gap-4">
              <span>{secondaryTransaction.label}</span>
              {explorerAction(secondaryTransaction.explorerUrl)}
            </div>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={onStartAnother}>
            {startAnotherLabel}
          </Button>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
