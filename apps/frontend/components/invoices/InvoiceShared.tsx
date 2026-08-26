"use client";

import Link from "next/link";
import { Copy, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useHybridWallet } from "@/components/providers/HybridWalletProvider";
import type { InvoiceStatus } from "@/lib/invoice-api";
import { getInvoiceCheckoutUrl } from "@/lib/invoice-links";
import { InvoiceQrCode } from "./InvoiceQrCode";

export function useMerchantInvoiceSession() {
  const circle = useCircleWallet();
  const hybrid = useHybridWallet();
  return {
    userToken:
      circle.authMethod === "email" || circle.authMethod === "google"
        ? circle.userToken
        : null,
    ready: circle.ready,
    walletMode: hybrid.walletMode,
    useAppWallet: () => hybrid.setWalletMode("circle"),
  };
}

export function MerchantInvoiceAuthNotice({
  walletMode,
  ready,
  onUseAppWallet,
}: {
  walletMode: string;
  ready: boolean;
  onUseAppWallet: () => void;
}) {
  return (
    <Card className="glass-card border-amber-500/30">
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="text-lg font-semibold">
            App Wallet merchant session required
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Invoice management is authenticated with the active Circle
            User-Controlled Wallet session. External Wallet identity is accepted
            only for public checkout payments.
          </p>
        </div>
        {walletMode !== "circle" ? (
          <Button onClick={onUseAppWallet}>Use App Wallet</Button>
        ) : (
          <p className="text-sm text-amber-300">
            {ready
              ? "Sign in with Circle to manage invoices."
              : "Loading Circle authentication..."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function InvoicePageHeader({
  title,
  description,
  create = false,
}: {
  title: string;
  description: string;
  create?: boolean;
}) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {create ? (
        <Button asChild>
          <Link href="/invoices/new">
            <Plus className="mr-2 h-4 w-4" />
            New invoice
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const style =
    status === "PAID"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : status === "OPEN"
        ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
        : status === "VERIFYING"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
          : "border-red-500/30 bg-red-500/10 text-red-300";
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}
    >
      {status}
    </span>
  );
}

export function InvoiceSharePanel({ publicId }: { publicId: string }) {
  const url = getInvoiceCheckoutUrl(publicId);
  const [copied, setCopied] = useState(false);
  return (
    <Card className="glass-card border-border/40">
      <CardHeader>
        <CardTitle className="text-base">Public payment link</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-center">
          <InvoiceQrCode value={url} size={200} />
        </div>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/40 bg-background/40 px-3 py-2 text-left text-xs"
          onClick={() =>
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <span className="break-all font-mono">{url}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-primary">
            <Copy className="h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy"}
          </span>
        </button>
        <Button asChild variant="outline" className="w-full">
          <Link href={`/pay/${publicId}`} target="_blank">
            Open checkout
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
