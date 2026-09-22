"use client";

import Link from "next/link";
import { Copy, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useExternalWallet } from "@/components/providers/external-wallet-context";
import { useAppKit } from "@reown/appkit/react";
import type { InvoiceStatus } from "@/lib/invoice-api";
import { getInvoiceCheckoutUrl } from "@/lib/invoice-links";
import { useWalletAuth } from "@/components/providers/WalletAuthProvider";
import { InvoiceQrCode } from "./InvoiceQrCode";

export type MerchantInvoiceSession = {
  /** Opaque bearer token issued after wallet ownership verification. */
  userToken: string | null;
  registered: boolean;
  registering: boolean;
  registerError: string | null;
  retry: () => void;
  ready: boolean;
  walletMode: "external";
  walletAddress: string | undefined;
  useAppWallet: () => void;
};

/**
 * Merchant invoice session for Arc Mainnet external wallets.
 *
 * A one-time EIP-191 message signature proves wallet ownership. The backend
 * returns an opaque session token; no key or transaction signature is used.
 */
export function useMerchantInvoiceSession(): MerchantInvoiceSession {
  const { isReady, activeWalletAddress } = useExternalWallet();
  const auth = useWalletAuth();

  return {
    userToken: auth.sessionToken,
    registered: auth.state === "authenticated",
    registering: auth.state === "authenticating",
    registerError: auth.error,
    retry: () => void auth.authenticate().catch(() => undefined),
    ready: isReady,
    walletMode: "external",
    walletAddress: activeWalletAddress,
    useAppWallet: () => {},
  };
}

export function MerchantInvoiceAuthNotice({
  walletMode,
  ready,
  onUseAppWallet,
  session,
}: {
  walletMode: string;
  ready: boolean;
  onUseAppWallet: () => void;
  session?: Pick<
    MerchantInvoiceSession,
    | "registered"
    | "registering"
    | "registerError"
    | "retry"
    | "userToken"
    | "walletAddress"
  >;
}) {
  void walletMode;
  void onUseAppWallet;
  const { open } = useAppKit();
  if (!session?.walletAddress) {
    return (
      <Card className="glass-card border-border/40">
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-lg font-semibold">Connect an external wallet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Merchant invoices on Arc Mainnet are scoped to your connected
              external wallet. Connect to create and manage payment requests.
            </p>
          </div>
          {!ready ? (
            <p className="text-sm text-amber-300">
              Loading external wallet session...
            </p>
          ) : (
            <Button onClick={() => void open({ view: "Connect" })}>
              Connect External Wallet
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }
  if (session.registering) {
    return (
      <Card className="glass-card border-border/40">
        <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Verifying wallet ownership...
        </CardContent>
      </Card>
    );
  }
  if (session.registerError || !session.registered) {
    return (
      <Card className="glass-card border-amber-500/30">
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-lg font-semibold">
              Authenticate your wallet
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {session.registerError ??
                "Sign a message to prove wallet ownership. This will not send a transaction or spend funds."}
            </p>
          </div>
          <Button variant="outline" onClick={session.retry}>
            {session.registerError ? "Retry authentication" : "Authenticate wallet"}
          </Button>
        </CardContent>
      </Card>
    );
  }
  return null;
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
