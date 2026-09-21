"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useExternalWallet } from "@/components/providers/external-wallet-context";
import { useToast } from "@/hooks/use-toast";

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function SidebarWalletSummary({ walletActions }: { walletActions?: ReactNode }) {
  const { activeWalletAddress, activeWalletLabel } = useExternalWallet();
  const { toast } = useToast();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const walletEntries = activeWalletAddress
    ? [
        {
          id: "external",
          label: activeWalletLabel,
          address: activeWalletAddress,
        },
      ]
    : [];

  async function copyAddress(address: string, walletId: string, walletLabelText: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(walletId);
      toast({
        title: `${walletLabelText} copied`,
        description:
          "Use this address when you want incoming funds to land in your external wallet on Arc Mainnet.",
      });
      window.setTimeout(() => setCopiedAddress(null), 2000);
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {walletEntries.length > 0 ? (
        <div className="space-y-1.5">
          <p className="px-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-[0.2em]">
            Connected Wallet
          </p>
          <div className="space-y-2">
            {walletEntries.map((wallet) => (
              <button
                key={wallet.id}
                onClick={() => void copyAddress(wallet.address, wallet.id, wallet.label)}
                aria-label={`Copy ${wallet.label}`}
                title={wallet.address}
                className="flex w-full items-center justify-between rounded-xl border border-border/40 bg-background/30 px-3 py-2.5 text-left text-sm font-mono text-foreground/75 transition-all hover:bg-primary/8 hover:text-primary hover:border-primary/20 active:scale-[0.98]"
              >
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/55">{wallet.label}</p>
                  <p>{truncateAddress(wallet.address)}</p>
                </div>
                {copiedAddress === wallet.id ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4 text-muted-foreground/50" />}
              </button>
            ))}
          </div>
          <p className="px-1 text-[11px] text-muted-foreground/60 leading-relaxed">
            This is the EVM address connected through your external wallet on
            Arc Mainnet (chain 5042).
          </p>
          {walletActions ? <div className="pt-1">{walletActions}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
