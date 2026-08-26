"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { parseUnits } from "viem";
import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import {
  InvoicePageHeader,
  InvoiceSharePanel,
  MerchantInvoiceAuthNotice,
  useMerchantInvoiceSession,
} from "@/components/invoices/InvoiceShared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenIcon } from "@/components/ui/token-icon";
import { createInvoice, type MerchantInvoice } from "@/lib/invoice-api";
import {
  ARC_TESTNET_CHAIN_ID,
  SUPPORTED_TOKENS,
  type TokenSymbol,
} from "@/lib/wizpay";

export default function NewInvoicePage() {
  const session = useMerchantInvoiceSession();
  const [token, setToken] = useState<TokenSymbol>("USDC");
  const [amount, setAmount] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [minimumExpiry] = useState(() =>
    new Date(Date.now() + 60_000).toISOString().slice(0, 16),
  );
  const [created, setCreated] = useState<MerchantInvoice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!session.userToken || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const invoice = await createInvoice(
        {
          token,
          amount,
          title,
          ...(description.trim() ? { description } : {}),
          ...(invoiceNumber.trim() ? { invoiceNumber } : {}),
          ...(expiresAt
            ? { expiresAt: new Date(expiresAt).toISOString() }
            : {}),
        },
        session.userToken,
      );
      setCreated(invoice);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Invoice could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardAppFrame>
      <InvoicePageHeader
        title="New invoice"
        description="Create one immutable fixed-amount payment request."
      />
      {!session.userToken ? (
        <MerchantInvoiceAuthNotice
          walletMode={session.walletMode}
          ready={session.ready}
          onUseAppWallet={session.useAppWallet}
        />
      ) : created ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="glass-card border-emerald-500/30">
            <CardHeader>
              <CardTitle>Invoice ready to share</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The receiving wallet, chain, token, decimals, and amount are now
                immutable.
              </p>
              <Preview
                token={created.token.symbol}
                amount={created.amount}
                title={created.title}
                description={created.description ?? ""}
                expiresAt={created.expiresAt ?? ""}
              />
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link href={`/invoices/${created.id}`}>View invoice</Link>
                </Button>
                <Button variant="outline" onClick={() => setCreated(null)}>
                  Create another
                </Button>
              </div>
            </CardContent>
          </Card>
          <InvoiceSharePanel publicId={created.publicId} />
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]"
        >
          <Card className="glass-card border-border/40">
            <CardContent className="space-y-5 p-5 sm:p-6">
              <div className="space-y-2">
                <Label htmlFor="invoice-token">Token</Label>
                <div className="relative">
                  <TokenIcon
                    chainId={ARC_TESTNET_CHAIN_ID}
                    address={SUPPORTED_TOKENS[token].address}
                    symbol={token}
                    size={26}
                    className="pointer-events-none absolute left-3 top-2 z-10"
                  />
                  <select
                    id="invoice-token"
                    className="h-11 w-full rounded-md border border-input bg-background pl-12 pr-3 text-sm"
                    value={token}
                    onChange={(event) =>
                      setToken(event.target.value as TokenSymbol)
                    }
                  >
                    <option value="USDC">USDC — USD Coin</option>
                    <option value="EURC">EURC — Euro Coin</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoice-amount">Fixed amount</Label>
                <Input
                  id="invoice-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  required
                  pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?"
                  placeholder="Enter amount"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoice-title">Customer-facing title</Label>
                <Input
                  id="invoice-title"
                  maxLength={120}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  placeholder="Consulting services"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoice-description">
                  Description (optional)
                </Label>
                <textarea
                  id="invoice-description"
                  maxLength={1000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="invoice-number">
                    Invoice number (optional)
                  </Label>
                  <Input
                    id="invoice-number"
                    maxLength={80}
                    value={invoiceNumber}
                    onChange={(event) => setInvoiceNumber(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invoice-expiry">Expiry (optional)</Label>
                  <Input
                    id="invoice-expiry"
                    type="datetime-local"
                    value={expiresAt}
                    min={minimumExpiry}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                </div>
              </div>
              {error ? (
                <p className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Create invoice
              </Button>
            </CardContent>
          </Card>
          <Card className="glass-card h-fit border-border/40 lg:sticky lg:top-6">
            <CardHeader>
              <CardTitle className="text-base">Checkout preview</CardTitle>
            </CardHeader>
            <CardContent>
              <Preview
                token={token}
                amount={validPreviewAmount(
                  amount,
                  SUPPORTED_TOKENS[token].decimals,
                )}
                title={title || "Invoice title"}
                description={description}
                expiresAt={expiresAt}
              />
            </CardContent>
          </Card>
        </form>
      )}
    </DashboardAppFrame>
  );
}

function Preview({
  token,
  amount,
  title,
  description,
  expiresAt,
}: {
  token: TokenSymbol;
  amount: string | null;
  title: string;
  description: string;
  expiresAt: string;
}) {
  return (
    <div className="space-y-4 rounded-2xl border border-border/40 bg-background/30 p-4">
      <div>
        <p className="text-xs text-muted-foreground">Payment request</p>
        <h2 className="mt-1 font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <TokenIcon
          chainId={ARC_TESTNET_CHAIN_ID}
          address={SUPPORTED_TOKENS[token].address}
          symbol={token}
          size={30}
        />
        <strong className="break-all text-xl">
          {amount ? `${amount} ${token}` : "Enter amount"}
        </strong>
      </div>
      <div className="text-xs text-muted-foreground">
        <p>Arc Testnet</p>
        <p>
          {expiresAt
            ? `Expires ${new Date(expiresAt).toLocaleString()}`
            : "Server default: 7 days"}
        </p>
      </div>
    </div>
  );
}

function validPreviewAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const fraction = normalized.split(".")[1] ?? "";
  if (fraction.length > decimals) return null;
  try {
    return parseUnits(normalized, decimals) > 0n ? normalized : null;
  } catch {
    return null;
  }
}
