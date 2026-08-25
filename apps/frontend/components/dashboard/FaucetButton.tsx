"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Droplet, Copy, Check } from "lucide-react";
import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useSmartWalletAddress } from "@/hooks/useSmartWalletAddress";
import { resolveCanonicalAppWalletEvmAddress } from "@/lib/canonical-app-wallet";

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

interface FaucetButtonProps {
  compact?: boolean;
  walletActions?: ReactNode;
}

export function FaucetButton({ compact = false, walletActions }: FaucetButtonProps) {
  const {
    arcWallet,
    primaryWallet,
    sepoliaWallet,
  } = useCircleWallet();
  const {
    smartWalletAddress,
    isLoadingSmartWalletAddress,
    walletLabel,
    walletMode,
  } = useSmartWalletAddress();
  const { toast } = useToast();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const appWallet = resolveCanonicalAppWalletEvmAddress(
    arcWallet?.address,
    sepoliaWallet?.address,
    primaryWallet?.address,
    walletMode === "circle" ? smartWalletAddress : null,
  );
  const walletEntries =
    walletMode === "circle"
      ? appWallet.address
        ? [{ id: "evm", label: "EVM Address", address: appWallet.address }]
        : []
      : smartWalletAddress
        ? [
            {
              id: "external",
              label: walletLabel,
              address: smartWalletAddress,
            },
          ]
        : [];

  useEffect(() => {
    if (appWallet.mismatch && process.env.NODE_ENV !== "production") {
      console.error(
        "[WizPay] App Wallet EVM address mismatch: refusing to select a network-specific address.",
      );
    }
  }, [appWallet.mismatch]);

  async function copyAddress(
    address: string,
    walletId: string,
    walletLabelText: string
  ) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(walletId);
      toast({
        title: `${walletLabelText} copied`,
        description:
          walletMode === "circle"
            ? "Use this EVM address across supported EVM networks."
            : "Use this address when you want incoming funds to land in your external wallet.",
      });
      window.setTimeout(() => setCopiedAddress(null), 2000);
    } catch (error) {
      console.error(error);
    }
  }

  if (compact) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-6 text-muted-foreground/75">
          Open Circle Faucet to top up your connected testnet wallets before you
          bridge, swap, or add liquidity on mobile.
        </p>
        <Button
          variant="outline"
          className="h-11 w-full justify-start gap-3 rounded-2xl border-primary/20 bg-primary/8 text-foreground shadow-sm hover:border-primary/35 hover:bg-primary/12"
          asChild
        >
          <a
            href="https://faucet.circle.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="flex items-center justify-center rounded-xl bg-primary/15 p-1.5 text-primary">
              <Droplet className="h-4 w-4" />
            </div>
            Open Circle Faucet
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {isLoadingSmartWalletAddress ? (
        <div className="space-y-1.5">
          <p className="px-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-[0.2em]">
            Smart Wallet
          </p>
          <div className="h-11 rounded-xl border border-border/40 bg-background/20 animate-pulse" />
        </div>
      ) : null}

      {walletEntries.length > 0 && (
        <div className="space-y-1.5">
          <p className="px-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-[0.2em]">
            {walletMode === "circle" ? "App Wallet" : "Connected Wallet"}
          </p>
          <div className="space-y-2">
            {walletEntries.map((wallet) => (
              <button
                key={wallet.id}
                onClick={() =>
                  void copyAddress(wallet.address, wallet.id, wallet.label)
                }
                aria-label={`Copy ${wallet.label}`}
                title={wallet.address}
                className="flex w-full items-center justify-between rounded-xl border border-border/40 bg-background/30 px-3 py-2.5 text-left text-sm font-mono text-foreground/75 transition-all hover:bg-primary/8 hover:text-primary hover:border-primary/20 active:scale-[0.98]"
              >
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/55">
                    {wallet.label}
                  </p>
                  <p>{truncateAddress(wallet.address)}</p>
                </div>
                {copiedAddress === wallet.id ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4 text-muted-foreground/50" />
                )}
              </button>
            ))}
          </div>
          <p className="px-1 text-[11px] text-muted-foreground/60 leading-relaxed">
            {walletMode === "circle"
              ? "Use this canonical App Wallet address across supported EVM networks."
              : "This is the EVM address connected through your external wallet."}
          </p>
          {walletActions ? <div className="pt-1">{walletActions}</div> : null}
        </div>
      )}

      {walletMode === "circle" && appWallet.mismatch ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs leading-5 text-destructive"
        >
          App Wallet EVM addresses do not match. Address display is blocked to
          prevent funding the wrong wallet.
        </div>
      ) : null}

      <div className="space-y-1.5">
        {walletEntries.length > 0 && (
          <p className="px-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-[0.2em]">
            Circle Faucet
          </p>
        )}
        <Button
          variant="outline"
          className="w-full justify-start gap-3 border-border/40 bg-background/30 text-muted-foreground shadow-sm hover:border-primary/30 hover:bg-primary/8 hover:text-primary transition-all group"
          asChild
        >
          <a
            href="https://faucet.circle.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="flex items-center justify-center rounded-lg bg-primary/15 p-1.5 text-primary group-hover:scale-110 group-hover:shadow-lg group-hover:shadow-primary/20 transition-all">
              <Droplet className="h-4 w-4" />
            </div>
            Get Circle Test Tokens ↗
          </a>
        </Button>
      </div>
    </div>
  );
}
