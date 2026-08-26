"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { TokenIcon } from "@/components/ui/token-icon";
import { TransactionSuccessDialog } from "@/components/dashboard/TransactionSuccessDialog";
import { useInvoicePayment } from "@/hooks/useInvoicePayment";
import { getPublicInvoice, type PublicInvoice } from "@/lib/invoice-api";
import { getInvoiceCheckoutUrl } from "@/lib/invoice-links";
import { getExplorerTxUrl } from "@/lib/wizpay";
import { InvoiceQrCode } from "./InvoiceQrCode";

export function PublicInvoiceCheckout({ publicId }: { publicId: string }) {
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [successOpen, setSuccessOpen] = useState(false);
  const applyInvoice = useCallback((next: PublicInvoice) => {
    setInvoice(next);
    if (next.status === "PAID") setSuccessOpen(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void getPublicInvoice(publicId, controller.signal)
      .then(applyInvoice)
      .catch((error) =>
        setLoadError(
          error instanceof Error
            ? error.message
            : "Payment request could not be loaded.",
        ),
      )
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [applyInvoice, publicId]);

  if (loading)
    return (
      <StandaloneShell>
        <PageSkeleton cards={3} />
      </StandaloneShell>
    );
  if (!invoice || loadError)
    return (
      <StandaloneShell>
        <StateCard
          tone="red"
          title="Payment request unavailable"
          message={loadError ?? "This payment request was not found."}
        />
      </StandaloneShell>
    );
  return (
    <CheckoutLoaded
      invoice={invoice}
      onInvoice={applyInvoice}
      successOpen={successOpen}
      setSuccessOpen={setSuccessOpen}
    />
  );
}

function CheckoutLoaded({
  invoice,
  onInvoice,
  successOpen,
  setSuccessOpen,
}: {
  invoice: PublicInvoice;
  onInvoice: (invoice: PublicInvoice) => void;
  successOpen: boolean;
  setSuccessOpen: (open: boolean) => void;
}) {
  const payment = useInvoicePayment(invoice, onInvoice);
  const checkoutUrl = getInvoiceCheckoutUrl(invoice.publicId);
  const explorerUrl = getExplorerTxUrl(invoice.transactionHash);
  const terminal =
    invoice.status === "PAID" ||
    invoice.status === "EXPIRED" ||
    invoice.status === "CANCELLED";

  return (
    <StandaloneShell>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card className="glass-card border-border/40">
            <CardHeader className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                  <ShieldCheck className="h-4 w-4" /> Payment request
                </div>
                <StatusBadge status={invoice.status} />
              </div>
              <div>
                <CardTitle className="text-2xl sm:text-3xl">
                  {invoice.title}
                </CardTitle>
                {invoice.description ? (
                  <p className="mt-3 max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {invoice.description}
                  </p>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-6">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Amount due
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <TokenIcon
                    chainId={invoice.chain.id}
                    address={invoice.token.address}
                    symbol={invoice.token.symbol}
                    size={38}
                  />
                  <span className="break-all text-3xl font-bold sm:text-4xl">
                    {invoice.amount}
                  </span>
                  <span className="text-xl font-semibold text-muted-foreground">
                    {invoice.token.symbol}
                  </span>
                </div>
              </div>
              <Detail
                label="Network"
                value={`${invoice.chain.name} · ${invoice.chain.id}`}
              />
              <Detail
                label="Recipient"
                value={<CopyValue value={invoice.receivingAddress} compact />}
              />
              <Detail
                label="Expires"
                value={
                  invoice.expiresAt
                    ? new Date(invoice.expiresAt).toLocaleString()
                    : "No expiry"
                }
              />
              {invoice.transactionHash ? (
                <Detail
                  label="Verified transaction"
                  value={
                    <a
                      href={explorerUrl ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 break-all font-mono text-xs text-primary hover:underline"
                    >
                      {invoice.transactionHash}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  }
                />
              ) : null}
            </CardContent>
          </Card>

          <PaymentProgress stage={payment.stage} error={payment.error} />

          {!terminal ? (
            <Card className="glass-card border-border/40">
              <CardContent className="space-y-4 p-5 sm:p-6">
                <div>
                  <h2 className="text-lg font-semibold">Choose payment method</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    WizPay will request one exact ERC-20 transfer. The backend
                    marks this invoice paid only after independent receipt
                    verification.
                  </p>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Payment method"
                  className="grid gap-3 sm:grid-cols-2"
                >
                  <Button
                    type="button"
                    role="radio"
                    aria-checked={payment.method === "app"}
                    variant={payment.method === "app" ? "default" : "outline"}
                    className="h-auto min-h-20 justify-start whitespace-normal p-4 text-left"
                    disabled={payment.locked}
                    onClick={() => payment.selectMethod("app")}
                  >
                    <ShieldCheck className="mr-3 h-5 w-5 shrink-0" />
                    <span>
                      <span className="block font-semibold">App Wallet</span>
                      <span className="mt-1 block text-xs opacity-75">
                        Pay with your WizPay App Wallet
                      </span>
                    </span>
                  </Button>
                  <Button
                    type="button"
                    role="radio"
                    aria-checked={payment.method === "external"}
                    variant={payment.method === "external" ? "default" : "outline"}
                    className="h-auto min-h-20 justify-start whitespace-normal p-4 text-left"
                    disabled={payment.locked}
                    onClick={() => payment.selectMethod("external")}
                  >
                    <Wallet className="mr-3 h-5 w-5 shrink-0" />
                    <span>
                      <span className="block font-semibold">External Wallet</span>
                      <span className="mt-1 block text-xs opacity-75">
                        Pay with a connected external wallet
                      </span>
                    </span>
                  </Button>
                </div>

                {payment.method === "app" ? (
                  !payment.appAuthenticated ? (
                    <Button
                      className="w-full"
                      size="lg"
                      disabled={payment.checking}
                      onClick={payment.authenticateAppWallet}
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      Sign in to App Wallet
                    </Button>
                  ) : payment.canContinueAppAuthorization ? (
                    <Button
                      className="w-full"
                      size="lg"
                      disabled={payment.checking}
                      onClick={() => void payment.continueAppAuthorization()}
                    >
                      {payment.checking ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="mr-2 h-4 w-4" />
                      )}
                      Authorize existing payment
                    </Button>
                  ) : (
                    <PaymentButton invoice={invoice} payment={payment} />
                  )
                ) : !payment.isConnected ? (
                  <ConnectButton.Custom>
                    {({ mounted, openConnectModal }) => (
                      <Button
                        className="w-full"
                        size="lg"
                        disabled={!mounted || payment.locked}
                        onClick={openConnectModal}
                      >
                        <Wallet className="mr-2 h-4 w-4" />
                        Connect External Wallet
                      </Button>
                    )}
                  </ConnectButton.Custom>
                ) : (
                  <PaymentButton invoice={invoice} payment={payment} />
                )}

                {(payment.transactionHash ||
                  (payment.method === "app" && payment.locked)) &&
                invoice.status !== "PAID" ? (
                  <Button
                    className="w-full"
                    variant="outline"
                    disabled={payment.checking}
                    onClick={() => void payment.checkStatus()}
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${payment.checking ? "animate-spin" : ""}`}
                    />
                    Check status now
                  </Button>
                ) : null}
                <p className="text-center text-xs text-muted-foreground">
                  Never pay from the merchant receiving wallet. QR scanning only
                  opens this review page.
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="glass-card h-fit border-border/40 lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle className="text-base">Share this checkout</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-center">
              <InvoiceQrCode value={checkoutUrl} />
            </div>
            <CopyValue value={checkoutUrl} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              This QR contains only the HTTPS WizPay checkout URL. It does not
              execute a transfer.
            </p>
          </CardContent>
        </Card>
      </div>

      <TransactionSuccessDialog
        open={successOpen && invoice.status === "PAID"}
        title="Invoice paid"
        description="WizPay independently verified the exact Arc Testnet transfer and receipt."
        rows={[
          {
            label: "Amount",
            value: `${invoice.amount} ${invoice.token.symbol}`,
          },
          {
            label: "Recipient",
            value: (
              <span className="break-all font-mono text-xs">
                {invoice.receivingAddress}
              </span>
            ),
          },
          { label: "Network", value: invoice.chain.name },
        ]}
        transactionHash={invoice.transactionHash ?? undefined}
        explorerUrl={explorerUrl ?? undefined}
        onDone={() => setSuccessOpen(false)}
        onStartAnother={() => setSuccessOpen(false)}
        startAnotherLabel="Close"
      />
    </StandaloneShell>
  );
}

function PaymentButton({
  invoice,
  payment,
}: {
  invoice: PublicInvoice;
  payment: ReturnType<typeof useInvoicePayment>;
}) {
  return (
    <Button
      className="w-full"
      size="lg"
      disabled={payment.locked || payment.checking}
      onClick={() => void payment.pay()}
    >
      {payment.checking ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <ArrowRightLeft className="mr-2 h-4 w-4" />
      )}
      {payment.locked
        ? "Payment submitted"
        : `Pay ${invoice.amount} ${invoice.token.symbol}`}
    </Button>
  );
}

function StandaloneShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/30 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ArrowRightLeft className="h-5 w-5" />
          </div>
          <div>
            <p className="font-bold tracking-tight">WizPay</p>
            <p className="text-xs text-muted-foreground">
              Secure payment checkout
            </p>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: PublicInvoice["status"] }) {
  const styles =
    status === "PAID"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : status === "OPEN"
        ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
        : status === "VERIFYING"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
          : "border-red-500/30 bg-red-500/10 text-red-300";
  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs font-semibold ${styles}`}
    >
      {status}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-between gap-2 border-b border-border/30 pb-4 text-sm last:border-0 last:pb-0 sm:flex-row">
      <span className="text-muted-foreground">{label}</span>
      <div className="max-w-full text-left font-medium sm:max-w-[70%] sm:text-right">
        {value}
      </div>
    </div>
  );
}

function CopyValue({
  value,
  compact = false,
}: {
  value: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const display = compact ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
      }
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/40 bg-background/40 px-3 py-2 text-left text-xs hover:border-primary/30"
    >
      <span className="min-w-0 break-all font-mono">{display}</span>
      <span className="inline-flex shrink-0 items-center gap-1 text-primary">
        <Copy className="h-3.5 w-3.5" />
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

function PaymentProgress({
  stage,
  error,
}: {
  stage: ReturnType<typeof useInvoicePayment>["stage"];
  error: string | null;
}) {
  if (stage === "ready") return null;
  const terminal =
    stage === "terminal_error" || stage === "expired" || stage === "cancelled";
  const paid = stage === "paid";
  const retryable = stage === "recoverable_error";
  const title = paid
    ? "Payment verified"
    : stage === "expired"
      ? "Invoice expired"
      : stage === "cancelled"
        ? "Invoice cancelled"
        : terminal
          ? "Payment evidence rejected"
          : retryable
            ? "Verification is temporarily unavailable"
            : stage.replaceAll("_", " ");
  const tone = paid
    ? "emerald"
    : terminal
      ? "red"
      : retryable
        ? "amber"
        : "cyan";
  return (
    <StateCard
      tone={tone}
      title={title}
      message={
        error ??
        (paid
          ? "The exact transfer is confirmed and this invoice is paid."
          : "Keep this page open. WizPay is checking Arc Testnet without requesting another signature.")
      }
      loading={!paid && !terminal && !retryable}
    />
  );
}

function StateCard({
  tone,
  title,
  message,
  loading = false,
}: {
  tone: "red" | "amber" | "emerald" | "cyan";
  title: string;
  message: string;
  loading?: boolean;
}) {
  const style =
    tone === "red"
      ? "border-red-500/30 bg-red-500/5 text-red-300"
      : tone === "amber"
        ? "border-amber-500/30 bg-amber-500/5 text-amber-300"
        : tone === "emerald"
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
          : "border-cyan-500/30 bg-cyan-500/5 text-cyan-300";
  const Icon = loading
    ? Loader2
    : tone === "emerald"
      ? CheckCircle2
      : tone === "red"
        ? AlertTriangle
        : Clock3;
  return (
    <Card className={style}>
      <CardContent className="flex gap-4 p-5">
        <Icon
          className={`mt-0.5 h-5 w-5 shrink-0 ${loading ? "animate-spin" : ""}`}
        />
        <div>
          <h2 className="font-semibold capitalize">{title}</h2>
          <p className="mt-1 text-sm opacity-80">{message}</p>
        </div>
      </CardContent>
    </Card>
  );
}
