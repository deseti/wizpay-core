"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CsvPreviewState } from "@/lib/batch-csv";
import type { TokenSymbol } from "@/lib/wizpay";

interface CsvPreviewDialogProps {
  csvPreview: CsvPreviewState | null;
  onClose: () => void;
  onConfirm: () => void;
  onDownloadTemplate: () => void;
  isBusy: boolean;
  selectedToken: TokenSymbol;
}

export function CsvPreviewDialog({
  csvPreview,
  onClose,
  onConfirm,
  onDownloadTemplate,
  isBusy,
  selectedToken,
}: CsvPreviewDialogProps) {
  return (
    <Dialog
      open={Boolean(csvPreview)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="glass-card grid-rows-[auto_auto_minmax(0,1fr)_auto] max-h-[92dvh] max-w-[calc(100vw-1rem)] border-border/40 bg-background/95 p-0 overflow-hidden sm:max-w-4xl">
        <DialogHeader className="px-4 pt-5 sm:px-6 sm:pt-6">
          <DialogTitle>Review CSV import</DialogTitle>
          <DialogDescription className="break-words">
            {csvPreview
              ? `${csvPreview.fileName} · ${csvPreview.rows.length} rows found. Only valid rows will be imported.`
              : "Review the file before importing recipients."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 px-4 sm:px-6 md:grid-cols-3">
          <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
              Rows found
            </p>
            <p className="mt-2 text-2xl font-semibold">
              {csvPreview?.rows.length ?? 0}
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-200/70">
              Ready to import
            </p>
            <p className="mt-2 text-2xl font-semibold text-emerald-100">
              {csvPreview?.validRows.length ?? 0}
            </p>
          </div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
            <p className="text-[11px] uppercase tracking-[0.16em] text-amber-200/70">
              Need attention
            </p>
            <p className="mt-2 text-2xl font-semibold text-amber-100">
              {csvPreview?.invalidCount ?? 0}
            </p>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6">
          <div className="space-y-3">
            {csvPreview?.rows.map((row) => (
              <div
                key={`${row.lineNumber}-${row.address}-${row.amount}`}
                className="rounded-2xl border border-border/40 bg-background/30 p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
                      Line {row.lineNumber}
                    </p>
                    <p className="font-mono text-xs break-all text-foreground/80">
                      {row.address || "No address provided"}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      row.errors.length === 0
                        ? "self-start border-emerald-500/20 bg-emerald-500/5 text-emerald-300/80"
                        : "self-start border-amber-500/20 bg-amber-500/5 text-amber-300/80"
                    }
                  >
                    {row.errors.length === 0 ? "Ready" : "Needs review"}
                  </Badge>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                      Amount
                    </p>
                    <p className="mt-1 font-mono text-sm text-foreground/80">
                      {row.amount || "-"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                      Token
                    </p>
                    <p className="mt-1 text-sm text-foreground/80">
                      {row.token || selectedToken}
                    </p>
                  </div>
                </div>

                {row.errors.length > 0 ? (
                  <div className="mt-3 space-y-1">
                    {row.errors.map((error) => (
                      <p
                        key={`${row.lineNumber}-${error}`}
                        className="text-xs text-amber-300/80"
                      >
                        {error}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="px-4 sm:px-6" showCloseButton>
          <Button
            type="button"
            variant="outline"
            onClick={onDownloadTemplate}
            className="w-full sm:w-auto"
          >
            Download Template
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={isBusy || !csvPreview?.validRows.length}
            className="w-full sm:w-auto"
          >
            Import {csvPreview?.validRows.length ?? 0} recipients
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
