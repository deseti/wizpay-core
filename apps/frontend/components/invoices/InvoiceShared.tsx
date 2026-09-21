"use client";

import Link from "next/link";
import { Copy, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useExternalWallet } from "@/components/providers/external-wallet-context";
import { useAppKit } from "@reown/appkit/react";
import type { InvoiceStatus } from "@/lib/invoice-api";
import { getInvoiceCheckoutUrl } from "@/lib/invoice-links";
import { ensureExternalWalletRegistered } from "@/lib/wallet-registration";
import { InvoiceQrCode } from "./InvoiceQrCode";

export type MerchantInvoiceSession = {
  /** Bearer token for merchant invoice/activity endpoints: the wallet address. */
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
 * The backend binds the merchant principal to the registered external wallet
 * address (presented as the bearer token). Registration is a self-custodial
 * address binding — no keys, no hosted wallet, no alternate network.
 */
export function useMerchantInvoiceSession(): MerchantInvoiceSession {
  const { isReady, activeWalletAddress } = useExternalWallet();
  const [registered, setRegistered] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!activeWalletAddress) {
      setRegistered(false);
      setRegistering(false);
      setRegisterError(null);
      return;
    }
    let cancelled = false;
    setRegistering(true);
    setRegisterError(null);
    void ensureExternalWalletRegistered(activeWalletAddress)
      .then(() => {
        if (!cancelled) setRegistered(true);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setRegistered(false);
          setRegisterError(
            cause instanceof Error
              ? cause.message
              : "Wallet registration failed.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRegistering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWalletAddress, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    userToken: activeWalletAddress ?? null,
    registered,
    registering,
    registerError,
    retry,
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
    "registered" | "registering" | "registerError" | "retry" | "userToken"
  >;
}) {
  void walletMode;
  void onUseAppWallet;
  const { open } = useAppKit();
  if (!session?.userToken) {
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
          Registering the external wallet for merchant invoices...
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
              Merchant registration needed
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {session.registerError ??
                "Register the external Arc Mainnet wallet before using invoices."}
            </p>
          </div>
          <Button variant="outline" onClick={session.retry}>
            Retry registration
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
