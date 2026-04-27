"use client";

import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
} from "lucide-react";
import type { Hex } from "viem";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BackendTask } from "@/lib/types";
import { EXPLORER_BASE_URL } from "@/lib/wizpay";

function txLink(hash: Hex) {
  return `${EXPLORER_BASE_URL}/tx/${hash}`;
}

function isExplorerHash(value: string): value is Hex {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

interface StatusBannersProps {
  task: BackendTask | null;
  copiedHash: string | null;
  copyHash: (hash: string | null) => Promise<void>;
}

export function StatusBanners({
  task,
  copiedHash,
  copyHash,
}: StatusBannersProps) {
  const latestLog = task?.logs[task.logs.length - 1] ?? null;
  const latestFailure = [...(task?.units ?? [])]
    .reverse()
    .find((unit) => unit.status === "FAILED");
  const submissionHashes = (task?.units ?? [])
    .map((unit) => unit.txHash)
    .filter((value): value is string => Boolean(value));
  const isSuccess = task?.status === "executed";
  const needsReview = task?.status === "review" || task?.status === "failed";
  const isActive = Boolean(task) && !isSuccess && !needsReview;

  return (
    <>
      {task ? (
        <Card className="glass-card border-primary/25 animate-fade-up">
          <CardContent className="flex items-start gap-3 pt-4">
            <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary/15">
              {isSuccess ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              ) : needsReview ? (
                <AlertCircle className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              )}
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                Payroll task status
              </p>
              <p className="text-sm text-muted-foreground">
                {(task.status || "created").replace(/_/g, " ").toUpperCase()} • {task.completedUnits}/{task.totalUnits} completed
                {task.failedUnits > 0 ? ` • ${task.failedUnits} failed` : ""}
              </p>
              {latestLog?.message ? (
                <p className="text-sm text-muted-foreground">{latestLog.message}</p>
              ) : null}
              {isActive ? (
                <p className="text-xs text-muted-foreground/70">
                  Backend task state is authoritative for payroll progress and completion.
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {needsReview ? (
        <Card className="glass-card border-destructive/30 animate-fade-up">
          <CardContent className="flex items-start gap-3 pt-4">
            <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive/15">
              <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-destructive">
                Payroll needs review
              </p>
              <p className="text-sm text-muted-foreground">
                {latestFailure?.error ?? "One or more payroll batches failed. Review backend task logs and retry only the pending work."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {submissionHashes.length > 0 ? (
        <Card className="glass-card border-border/40 animate-fade-up">
          <CardHeader>
            <CardTitle>Latest Transactions</CardTitle>
            <CardDescription>
              Reported on-chain transaction hashes from the backend task units.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {submissionHashes.map((hash, index) => (
              <div
                key={`${hash}-${index}`}
                className="flex flex-col gap-2 rounded-xl border border-border/40 bg-background/35 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">Batch {index + 1}</p>
                    {isSuccess ? (
                      <Badge className="gap-1 bg-emerald-500/15 text-emerald-300 border-emerald-500/25">
                        <CheckCircle2 className="h-3 w-3" />
                        Reported
                      </Badge>
                    ) : null}
                  </div>
                  <p className="break-all font-mono text-xs text-muted-foreground/70">
                    {hash}
                  </p>
                  {!isExplorerHash(hash) ? (
                    <p className="text-xs text-muted-foreground/70">
                      A temporary wallet/provider reference was reported before the final Arc transaction hash became available.
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyHash(hash)}
                    className="gap-1 border-border/40 hover:border-primary/20"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {copiedHash === hash ? "Copied" : "Copy"}
                  </Button>
                  {isExplorerHash(hash) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="gap-1 border-border/40 hover:border-primary/20"
                    >
                      <a
                        href={txLink(hash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        ArcScan
                      </a>
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
