"use client";

import Link from "next/link";
import { Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import {
  InvoicePageHeader,
  InvoiceStatusBadge,
  MerchantInvoiceAuthNotice,
  useMerchantInvoiceSession,
} from "@/components/invoices/InvoiceShared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { TokenIcon } from "@/components/ui/token-icon";
import { getInvoiceCheckoutUrl } from "@/lib/invoice-links";
import {
  listInvoices,
  type InvoiceStatus,
  type MerchantInvoice,
} from "@/lib/invoice-api";
import { getExplorerTxUrl } from "@/lib/wizpay";

const FILTERS: Array<{ label: string; value?: InvoiceStatus }> = [
  { label: "All" },
  { label: "Open", value: "OPEN" },
  { label: "Verifying", value: "VERIFYING" },
  { label: "Paid", value: "PAID" },
  { label: "Expired", value: "EXPIRED" },
  { label: "Cancelled", value: "CANCELLED" },
];
const PAGE_SIZE = 10;

export default function InvoicesPage() {
  const session = useMerchantInvoiceSession();
  const [status, setStatus] = useState<InvoiceStatus | undefined>();
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<MerchantInvoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!session.userToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listInvoices(session.userToken, {
        status,
        limit: PAGE_SIZE,
        offset,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Invoices could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [offset, session.userToken, status]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <DashboardAppFrame>
      <InvoicePageHeader
        title="Invoices"
        description="Create and track fixed Arc Testnet payment requests."
        create
      />
      {!session.userToken ? (
        <MerchantInvoiceAuthNotice
          walletMode={session.walletMode}
          ready={session.ready}
          onUseAppWallet={session.useAppWallet}
        />
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {FILTERS.map((filter) => (
              <Button
                key={filter.label}
                size="sm"
                variant={status === filter.value ? "default" : "outline"}
                onClick={() => {
                  setStatus(filter.value);
                  setOffset(0);
                }}
              >
                {filter.label}
              </Button>
            ))}
          </div>
          {loading ? (
            <PageSkeleton cards={2} />
          ) : error ? (
            <Card className="border-red-500/30">
              <CardContent className="p-6 text-red-300">
                {error}
                <Button
                  variant="outline"
                  className="ml-4"
                  onClick={() => void load()}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : items.length === 0 ? (
            <Card className="glass-card">
              <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
                <h2 className="text-lg font-semibold">No invoices found</h2>
                <p className="text-sm text-muted-foreground">
                  Create a fixed USDC or EURC payment request to get started.
                </p>
                <Button asChild>
                  <Link href="/invoices/new">Create invoice</Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {items.map((invoice) => (
                <InvoiceRow key={invoice.id} invoice={invoice} />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total
                ? `${offset + 1}-${Math.min(offset + PAGE_SIZE, total)} of ${total}`
                : "0 invoices"}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </DashboardAppFrame>
  );
}

function InvoiceRow({ invoice }: { invoice: MerchantInvoice }) {
  const url = getInvoiceCheckoutUrl(invoice.publicId);
  return (
    <Card className="glass-card border-border/40">
      <CardContent className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
        <Link href={`/invoices/${invoice.id}`} className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold">{invoice.title}</h2>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <TokenIcon
              chainId={invoice.chain.id}
              address={invoice.token.address}
              symbol={invoice.token.symbol}
              size={22}
            />
            <strong>
              {invoice.amount} {invoice.token.symbol}
            </strong>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Created {new Date(invoice.createdAt).toLocaleString()} · Expires{" "}
            {invoice.expiresAt
              ? new Date(invoice.expiresAt).toLocaleString()
              : "never"}
          </p>
        </Link>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(url)}
          >
            <Copy className="mr-1 h-3.5 w-3.5" />
            Copy link
          </Button>
          {invoice.transactionHash ? (
            <Button asChild size="sm" variant="outline">
              <a
                href={getExplorerTxUrl(invoice.transactionHash) ?? "#"}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" />
                Transaction
              </a>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
