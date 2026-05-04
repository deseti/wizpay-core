"use client";

import { AlertCircle, Download, Loader2, Plus, Rocket, Upload, Users } from "lucide-react";

import { RecipientScannerDialog } from "@/components/dashboard/RecipientScannerDialog";
import { AllRecipientsDialog } from "@/components/dashboard/batch/AllRecipientsDialog";
import { CsvPreviewDialog } from "@/components/dashboard/batch/CsvPreviewDialog";
import { RecipientMobileCard } from "@/components/dashboard/batch/RecipientMobileCard";
import { RecipientRow } from "@/components/dashboard/batch/RecipientRow";
import { useBatchComposerActions } from "@/components/dashboard/batch/useBatchComposerActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { PreparedRecipient, QuoteSummary } from "@/lib/types";
import {
  activeFxEngineAddress,
  fxProviderLabel,
  isStableFxMode,
  permit2Address,
} from "@/lib/fx-config";
import { RECIPIENT_PREVIEW_LIMIT } from "@/lib/batch-csv";
import {
  formatCompactAddress,
  formatTokenAmount,
  type RecipientDraft,
  type TokenSymbol,
} from "@/lib/wizpay";
import { useActionGuard } from "@/hooks/useActionGuard";

interface BatchComposerProps {
  selectedToken: TokenSymbol;
  activeToken: { symbol: TokenSymbol; decimals: number };
  recipients: RecipientDraft[];
  preparedRecipients: PreparedRecipient[];
  referenceId: string;
  onReferenceIdChange: (value: string) => void;
  errors: Record<string, string>;
  clearFieldError: (key: string) => void;
  batchAmount: bigint;
  validRecipientCount: number;
  quoteSummary: QuoteSummary;
  quoteLoading: boolean;
  quoteRefreshing: boolean;
  rowDiagnostics: (string | null)[];
  isBusy: boolean;
  insufficientBalance: boolean;
  updateRecipient: (
    id: string,
    field: keyof Omit<RecipientDraft, "id">,
    value: string,
  ) => void;
  addRecipient: () => void;
  removeRecipient: (id: string) => void;
  resetComposer: () => void;
  setErrorMessage: (msg: string | null) => void;
  importRecipients: (rows: RecipientDraft[]) => void;
  totalBatches: number;
  currentBatchNumber: number;
  smartBatchAvailable?: boolean;
  smartBatchRunning?: boolean;
  smartBatchReason?: string | null;
  smartBatchButtonText?: string | null;
  smartBatchHelperText?: string | null;
  handleSmartBatchSubmit?: () => Promise<void>;
}

export function BatchComposer({
  selectedToken,
  activeToken,
  recipients,
  preparedRecipients,
  referenceId,
  onReferenceIdChange,
  errors,
  clearFieldError,
  batchAmount,
  validRecipientCount,
  quoteSummary,
  quoteLoading,
  quoteRefreshing,
  rowDiagnostics,
  isBusy,
  insufficientBalance,
  updateRecipient,
  addRecipient,
  removeRecipient,
  resetComposer,
  setErrorMessage,
  importRecipients,
  totalBatches,
  currentBatchNumber,
  smartBatchAvailable = false,
  smartBatchRunning = false,
  smartBatchReason,
  smartBatchButtonText,
  smartBatchHelperText,
  handleSmartBatchSubmit,
}: BatchComposerProps) {
  const canSend = smartBatchAvailable && Boolean(handleSmartBatchSubmit);
  const { isProcessing: isSendGuarded, guard: guardSend } = useActionGuard();
  const visibleRecipients = preparedRecipients.slice(0, RECIPIENT_PREVIEW_LIMIT);
  const hiddenRecipientsCount = Math.max(
    0,
    preparedRecipients.length - RECIPIENT_PREVIEW_LIMIT,
  );

  const {
    csvInputRef,
    csvLoading,
    csvPreview,
    setCsvPreview,
    showAllRecipients,
    setShowAllRecipients,
    scannerRecipientId,
    setScannerRecipientId,
    handleDownloadTemplate,
    handleScannedAddress,
    handleConfirmCsvImport,
    handleCsvUpload,
  } = useBatchComposerActions({
    selectedToken,
    importRecipients,
    setErrorMessage,
    updateRecipient,
    clearFieldError,
  });

  return (
    <>
      <Card className="glass-card border-border/40">
        <CardHeader className="soft-divider border-b border-border/30">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <CardTitle className="text-lg">
                User-Controlled Payroll on Arc
              </CardTitle>
              <CardDescription>
                Payroll executes client-side through the active wallet. Imported
                recipient lists can contain 50, 100, or 1000 recipients in one
                run; the app just splits them into Arc batches of up to 50
                recipients, and each batch is confirmed from the user wallet.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {totalBatches > 1 && (
                <Badge
                  variant="default"
                  className="font-mono text-[11px] bg-primary text-primary-foreground"
                >
                  Batch {currentBatchNumber} of {totalBatches}
                </Badge>
              )}
              <Badge
                variant="outline"
                className="font-mono text-[11px] border-amber-500/20 text-amber-300/80 bg-amber-500/5"
              >
                Arc max: 50 / batch
              </Badge>
              <Badge
                variant="outline"
                className="font-mono text-[11px] border-primary/20 text-primary/70 bg-primary/5"
              >
                {`${fxProviderLabel}: ${formatCompactAddress(activeFxEngineAddress)}`}
              </Badge>
              {isStableFxMode ? (
                <Badge
                  variant="outline"
                  className="font-mono text-[11px] border-sky-500/20 text-sky-300/80 bg-sky-500/5"
                >
                  Permit2: {formatCompactAddress(permit2Address)}
                </Badge>
              ) : null}
              <Badge
                variant="outline"
                className="border-emerald-500/20 text-emerald-300/80 bg-emerald-500/5"
              >
                {validRecipientCount}/{recipients.length} valid
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-5 pt-5">
          {/* Reference ID + Draft Summary */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="space-y-1.5">
              <label
                htmlFor="referenceId"
                className="text-sm font-medium text-foreground"
              >
                Reference ID or Memo
              </label>
              <Input
                id="referenceId"
                placeholder="PAYROLL-APR-2026"
                value={referenceId}
                onChange={(event) => {
                  onReferenceIdChange(event.target.value);
                  clearFieldError("referenceId");
                  setErrorMessage(null);
                }}
                disabled={isBusy}
                className="h-11 bg-background/50 border-border/40"
                aria-invalid={Boolean(errors.referenceId)}
              />
              {errors.referenceId ? (
                <p className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {errors.referenceId}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground/70">
                  This memo is stored on-chain in the batch event.
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground/60 font-semibold">
                Draft Summary
              </p>
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Recipients</span>
                  <span className="font-mono font-medium">
                    {preparedRecipients.length}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Total amount</span>
                  <span className="font-mono font-medium">
                    {formatTokenAmount(batchAmount, activeToken.decimals)}{" "}
                    {activeToken.symbol}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Estimated receive</span>
                  {quoteLoading ? (
                    <Skeleton className="h-4 w-24 bg-muted/20" />
                  ) : (
                    <span className="font-mono">
                      {formatTokenAmount(
                        quoteSummary.totalEstimatedOut,
                        activeToken.decimals,
                      )}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Est. fees</span>
                  {quoteLoading ? (
                    <Skeleton className="h-4 w-24 bg-muted/20" />
                  ) : (
                    <span className="font-mono">
                      {formatTokenAmount(
                        quoteSummary.totalFees,
                        activeToken.decimals,
                      )}{" "}
                      {activeToken.symbol}
                    </span>
                  )}
                </div>
              </div>
              {quoteRefreshing ? (
                <p className="mt-3 text-[11px] text-muted-foreground/60">
                  Updating quotes in the background...
                </p>
              ) : null}
            </div>
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-2xl border border-border/40 overflow-hidden md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/30">
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Wallet Address</TableHead>
                  <TableHead className="w-40">Target Token</TableHead>
                  <TableHead className="w-40">You Send</TableHead>
                  <TableHead className="w-40">They Receive</TableHead>
                  <TableHead className="w-28">Route</TableHead>
                  <TableHead className="w-16 text-right"> </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRecipients.map((recipient, index) => (
                  <RecipientRow
                    key={recipient.id}
                    recipient={recipient}
                    index={index}
                    selectedToken={selectedToken}
                    estimatedOut={quoteSummary.estimatedAmountsOut[index] ?? 0n}
                    diagnostic={rowDiagnostics[index] ?? null}
                    errors={errors}
                    quoteLoading={quoteLoading}
                    quoteRefreshing={quoteRefreshing}
                    isBusy={isBusy}
                    recipientCount={recipients.length}
                    updateRecipient={updateRecipient}
                    removeRecipient={removeRecipient}
                    onScanRequest={setScannerRecipientId}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {visibleRecipients.map((recipient, index) => (
              <RecipientMobileCard
                key={recipient.id}
                recipient={recipient}
                index={index}
                selectedToken={selectedToken}
                activeTokenDecimals={activeToken.decimals}
                estimatedOut={quoteSummary.estimatedAmountsOut[index] ?? 0n}
                diagnostic={rowDiagnostics[index] ?? null}
                errors={errors}
                quoteLoading={quoteLoading}
                quoteRefreshing={quoteRefreshing}
                isBusy={isBusy}
                recipientCount={recipients.length}
                updateRecipient={updateRecipient}
                removeRecipient={removeRecipient}
                onScanRequest={setScannerRecipientId}
              />
            ))}
          </div>

          {hiddenRecipientsCount > 0 ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-border/40 bg-background/20 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Users className="h-4 w-4 text-primary" />
                  +{hiddenRecipientsCount} more recipients
                </p>
                <p className="text-[11px] text-muted-foreground/65">
                  The composer shows the first {RECIPIENT_PREVIEW_LIMIT} rows so
                  the page stays light. Open the full list to review everyone.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="border-border/40"
                onClick={() => setShowAllRecipients(true)}
              >
                View all recipients
              </Button>
            </div>
          ) : null}

          {/* Add recipient + CSV upload */}
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <Button
                variant="outline"
                onClick={addRecipient}
                disabled={recipients.length >= 50 || isBusy}
                className="h-10 w-full justify-center gap-2 border-border/40 bg-background/40 transition-all hover:border-primary/30 hover:bg-primary/5 hover:text-primary sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                Add Recipient
              </Button>
              <Button
                variant="outline"
                onClick={() => csvInputRef.current?.click()}
                disabled={isBusy || csvLoading}
                className="h-10 w-full justify-center gap-2 border-border/40 bg-background/40 transition-all hover:border-primary/30 hover:bg-primary/5 hover:text-primary sm:w-auto"
              >
                {csvLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {csvLoading ? "Parsing..." : "Upload CSV"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleDownloadTemplate}
                disabled={isBusy}
                className="h-10 w-full justify-center gap-2 border-border/40 bg-background/40 transition-all hover:border-primary/30 hover:bg-primary/5 hover:text-primary sm:w-auto"
              >
                <Download className="h-4 w-4" />
                Download Template CSV
              </Button>
            </div>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleCsvUpload}
            />
            <p className="text-[11px] text-muted-foreground/60">
              Use address, amount, token. You will review every row before it is
              imported.
            </p>
          </div>
        </CardContent>

        <CardFooter className="flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between border-border/30">
          <div className="space-y-1 text-sm">
            <p className="font-semibold">
              Gross batch:{" "}
              {formatTokenAmount(batchAmount, activeToken.decimals)}{" "}
              {activeToken.symbol}
            </p>
            <p className="text-muted-foreground/70 text-xs">
              Execution path: active user-controlled wallet {"->"} Arc
              transaction(s)
            </p>
            {smartBatchAvailable ? (
              <p className="text-xs text-muted-foreground/70">
                {smartBatchHelperText ??
                  "Click Send once to request approval and submit every required Arc payroll batch from the active wallet. Circle user-controlled mode will show confirmation popups for each required signature."}
              </p>
            ) : smartBatchReason ? (
              <p className="text-xs text-amber-300/80">{smartBatchReason}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={resetComposer}
              disabled={isBusy}
              className="h-11 bg-background/40 border-border/40 hover:border-primary/20"
            >
              Reset
            </Button>
            <Button
              onClick={() => {
                void guardSend(
                  () => handleSmartBatchSubmit?.() ?? Promise.resolve(),
                );
              }}
              disabled={
                isBusy ||
                smartBatchRunning ||
                insufficientBalance ||
                !canSend ||
                isSendGuarded
              }
              className="h-11 gap-2 bg-gradient-to-r from-cyan-500 to-blue-500 text-white hover:brightness-110 shadow-lg shadow-cyan-500/20 transition-all active:scale-[0.97]"
            >
              {smartBatchRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              {smartBatchButtonText ?? "Send"}
            </Button>
          </div>
        </CardFooter>
      </Card>

      <AllRecipientsDialog
        open={showAllRecipients}
        onOpenChange={setShowAllRecipients}
        preparedRecipients={preparedRecipients}
        validRecipientCount={validRecipientCount}
        batchAmount={batchAmount}
        activeToken={activeToken}
        quoteSummary={quoteSummary}
        quoteLoading={quoteLoading}
        rowDiagnostics={rowDiagnostics}
        selectedToken={selectedToken}
      />

      <CsvPreviewDialog
        csvPreview={csvPreview}
        onClose={() => setCsvPreview(null)}
        onConfirm={handleConfirmCsvImport}
        onDownloadTemplate={handleDownloadTemplate}
        isBusy={isBusy}
        selectedToken={selectedToken}
      />

      <RecipientScannerDialog
        open={Boolean(scannerRecipientId)}
        onOpenChange={(open) => {
          if (!open) setScannerRecipientId(null);
        }}
        onDetected={handleScannedAddress}
      />
    </>
  );
}
