"use client";

import { useAppKit } from "@reown/appkit/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  Copy,
  User,
  Wallet,
  Wifi,
} from "lucide-react";

import { useExternalWallet } from "@/components/providers/external-wallet-context";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { activeArcChain } from "@/lib/wagmi";

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function MobileProfileEntry({
  label,
  statusLabel,
}: {
  label: string;
  statusLabel: string;
}) {
  return (
    <a
      href="/profile"
      className="flex items-center gap-2 rounded-2xl border border-border/40 bg-card/60 px-2.5 py-1.5 backdrop-blur-md shadow-lg shadow-black/10 transition-all hover:border-primary/25 hover:bg-primary/10 active:scale-95 md:hidden"
      aria-label="Open account"
    >
      <span className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-primary/25 to-violet-500/20 text-primary ring-1 ring-primary/20">
        <User className="h-4 w-4" />
        <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full border border-background bg-emerald-400" />
      </span>
      <span className="hidden min-[380px]:flex min-w-0 flex-col text-left leading-none">
        <span className="truncate text-[11px] font-semibold text-foreground">
          {label}
        </span>
        <span className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground/65">
          {statusLabel}
        </span>
      </span>
    </a>
  );
}

export function DashboardHeader() {
  const {
    activeWalletAddress,
    activeWalletChainId,
    activeWalletChainName,
    activeWalletLabel,
    activeWalletShortAddress,
    externalConnectorName,
    isReady,
    requiresArcSwitch,
  } = useExternalWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open: openAppKit } = useAppKit();
  const { toast } = useToast();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function copyAddress(
    address: string,
    copiedKey = "wallet",
    label = activeWalletLabel,
  ) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(copiedKey);
      toast({
        title: `${label} address copied`,
        description:
          "Use this address when you want incoming funds to land in your external wallet on Arc Mainnet.",
      });
      window.setTimeout(() => setCopiedAddress(null), 2000);
    } catch (error) {
      console.error(error);
    }
  }

  const showNetworkBadge = Boolean(activeWalletAddress);
  const isArcActive = activeWalletChainId === activeArcChain.id;
  const networkBadgeLabel = activeWalletChainName ?? "Arc Mainnet";

  return (
    <header className="sticky top-0 z-30 border-b border-border/40 bg-background/60 backdrop-blur-2xl">
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-3 sm:gap-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25 shadow-lg shadow-primary/10">
            <ArrowRightLeft className="h-4 w-4 icon-glow" />
          </div>
          <div className="hidden min-[380px]:block">
            <p className="text-base font-bold leading-tight tracking-tight neon-text">
              WizPay
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 ml-auto">
          {showNetworkBadge ? (
            <Badge
              variant="outline"
              className={`hidden sm:flex gap-1.5 text-[10px] px-2.5 py-1 ${
                isArcActive
                  ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300/80"
                  : "border-amber-500/25 bg-amber-500/10 text-amber-300"
              }`}
            >
              <Wifi className="h-2.5 w-2.5" />
              {requiresArcSwitch
                ? `Switch to Arc Mainnet · ${networkBadgeLabel}`
                : networkBadgeLabel}
            </Badge>
          ) : null}

          {!isReady ? (
            <div className="h-9 w-32 animate-pulse rounded-xl bg-muted/30" />
          ) : !activeWalletAddress ? (
            <button
              type="button"
              onClick={() => void openAppKit({ view: "Connect" })}
              className="glow-btn group relative flex items-center gap-2 rounded-xl bg-gradient-to-r from-primary to-violet-500 px-5 py-2.5 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-xl hover:shadow-primary/30 hover:brightness-110 active:scale-[0.97]"
            >
              <User className="h-4 w-4" />
              Connect External Wallet
            </button>
          ) : (
            <>
              <MobileProfileEntry
                label={activeWalletShortAddress ?? "Account"}
                statusLabel={activeWalletChainName ?? "External"}
              />
              <div
                ref={menuRef}
                className="relative hidden items-center gap-1.5 rounded-2xl border border-border/40 bg-card/50 p-1 backdrop-blur-md shadow-lg shadow-black/10 md:flex"
              >
                {activeWalletAddress ? (
                  <button
                    onClick={() => void copyAddress(activeWalletAddress)}
                    className="hidden items-center gap-1.5 rounded-xl px-2.5 py-2 font-mono text-[11px] text-foreground/75 transition-all hover:bg-primary/10 hover:text-primary active:scale-95 sm:flex sm:text-xs"
                    title="Copy active wallet address"
                  >
                    <span className="hidden min-[400px]:inline">
                      {activeWalletShortAddress}
                    </span>
                    <span className="inline min-[400px]:hidden">
                      {truncateAddress(activeWalletAddress)}
                    </span>
                    {copiedAddress === "wallet" ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    )}
                  </button>
                ) : null}

                <button
                  type="button"
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  aria-label="Account and wallet menu"
                  onClick={() => setMenuOpen((open) => !open)}
                  className="flex items-center gap-2 rounded-xl border border-transparent bg-background/80 px-3 py-2 transition-all hover:border-primary/20 hover:bg-primary/10 active:scale-95"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-primary/25 to-violet-500/20 text-[11px] font-bold text-primary ring-1 ring-primary/20">
                    {(externalConnectorName ?? "E").charAt(0)}
                  </span>
                  <span className="hidden text-left sm:flex sm:flex-col sm:leading-none">
                    <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
                      External Wallet
                    </span>
                    <span className="text-xs font-mono text-foreground/80">
                      {activeWalletShortAddress}
                    </span>
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                {menuOpen ? (
                  <div
                    role="menu"
                    aria-label="Account menu"
                    className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-2xl border border-border/40 bg-card/95 p-1 shadow-2xl shadow-black/30 backdrop-blur-xl"
                  >
                    <Link
                      href="/profile"
                      role="menuitem"
                      className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-primary/10"
                      onClick={() => setMenuOpen(false)}
                    >
                      <User className="h-4 w-4 text-primary" />
                      Account
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-primary/10"
                      onClick={() => {
                        setMenuOpen(false);
                        void openAppKit({
                          view:
                            activeWalletChainId !== activeArcChain.id
                              ? "Networks"
                              : "Account",
                        });
                      }}
                    >
                      <Wallet className="h-4 w-4 text-primary" />
                      Wallet
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
