"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import {
  InvoicePageHeader,
  InvoiceSharePanel,
  InvoiceStatusBadge,
  MerchantInvoiceAuthNotice,
  useMerchantInvoiceSession,
} from "@/components/invoices/InvoiceShared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { TokenIcon } from "@/components/ui/token-icon";
import {
  cancelInvoice,
  getMerchantInvoice,
  type MerchantInvoice,
} from "@/lib/invoice-api";
import { getExplorerTxUrl } from "@/lib/wizpay";

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const session = useMerchantInvoiceSession();
  const [invoice, setInvoice] = useState<MerchantInvoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!session.userToken) return;
    setLoading(true);
    setError(null);
    try {
      setInvoice(await getMerchantInvoice(id, session.userToken));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Invoice could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [id, session.userToken]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function cancel() {
    if (!session.userToken || !invoice || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      setInvoice(await cancelInvoice(invoice.id, session.userToken));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Invoice could not be cancelled.",
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <DashboardAppFrame>
      <InvoicePageHeader
        title="Invoice detail"
        description="Merchant-safe terms and independently verified payment evidence."
      />
      {!session.userToken ? (
        <MerchantInvoiceAuthNotice
          walletMode={session.walletMode}
          ready={session.ready}
          onUseAppWallet={session.useAppWallet}
        />
      ) : loading ? (
        <PageSkeleton cards={2} />
      ) : error && !invoice ? (
        <Card className="border-red-500/30">
          <CardContent className="p-6 text-red-300">
            {error}
            <Button
              className="ml-3"
              variant="outline"
              onClick={() => void load()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : invoice ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="glass-card border-border/40">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-2xl">{invoice.title}</CardTitle>
                  {invoice.invoiceNumber ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Invoice {invoice.invoiceNumber}
                    </p>
                  ) : null}
                </div>
                <InvoiceStatusBadge status={invoice.status} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-5">
                <TokenIcon
                  chainId={invoice.chain.id}
                  address={invoice.token.address}
                  symbol={invoice.token.symbol}
                  size={36}
                />
                <strong className="break-all text-2xl">
                  {invoice.amount} {invoice.token.symbol}
                </strong>
              </div>
              {invoice.description ? (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {invoice.description}
                </p>
              ) : null}
              <Term
                label="Network"
                value={`${invoice.chain.name} · ${invoice.chain.id}`}
              />
              <Term
                label="Token contract"
                value={
                  <span className="break-all font-mono text-xs">
                    {invoice.token.address}
                  </span>
                }
              />
              <Term
                label="Receiving wallet"
                value={
                  <span className="break-all font-mono text-xs">
                    {invoice.receivingAddress}
                  </span>
                }
              />
              <Term
                label="Amount units"
                value={
                  <span className="font-mono text-xs">
                    {invoice.amountUnits}
                  </span>
                }
              />
              <Term
                label="Created"
                value={new Date(invoice.createdAt).toLocaleString()}
              />
              <Term
                label="Expires"
                value={
                  invoice.expiresAt
                    ? new Date(invoice.expiresAt).toLocaleString()
                    : "Never"
                }
              />
              {invoice.payerAddress ? (
                <Term
                  label="Verified payer"
                  value={
                    <span className="break-all font-mono text-xs">
                      {invoice.payerAddress}
                    </span>
                  }
                />
              ) : null}
              {invoice.transactionHash ? (
                <Term
                  label="Verified transaction"
                  value={
                    <a
                      href={getExplorerTxUrl(invoice.transactionHash) ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 break-all font-mono text-xs text-primary"
                    >
                      {invoice.transactionHash}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  }
                />
              ) : null}
              {error ? (
                <p className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
                  {error}
                </p>
              ) : null}
              {invoice.status === "OPEN" ? (
                <Button
                  variant="destructive"
                  disabled={cancelling}
                  onClick={() => void cancel()}
                >
                  {cancelling ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Cancel invoice
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <InvoiceSharePanel publicId={invoice.publicId} />
        </div>
      ) : null}
    </DashboardAppFrame>
  );
}

function Term({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-between gap-2 border-b border-border/30 pb-3 text-sm sm:flex-row">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-full text-left font-medium sm:max-w-[70%] sm:text-right">
        {value}
      </span>
    </div>
  );
}
