"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { useDisconnect } from "wagmi";
import { type Address } from "viem";
import {
  AtSign,
  BadgeCheck,
  Check,
  Copy,
  ExternalLink,
  Globe2,
  Link2,
  LogOut,
  Mail,
  Network,
  Sparkles,
  User,
  WalletCards,
} from "lucide-react";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useHybridWallet } from "@/components/providers/HybridWalletProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

import { useProfileAnsDomains } from "./hooks/useProfileAnsDomains";
import { useProfilePreferences } from "./hooks/useProfilePreferences";

type AddressEntry = {
  id: string;
  label: string;
  network: string;
  value: string | null;
  description: string;
};

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-[1.4rem] border border-border/35 bg-background/35 px-4 py-4 backdrop-blur-sm">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
        {label}
      </p>
      <p className="mt-2 text-base font-semibold text-foreground sm:text-lg">
        {value}
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground/75">{hint}</p>
    </div>
  );
}

function AddressItem({
  copiedKey,
  entry,
  onCopy,
}: {
  copiedKey: string | null;
  entry: AddressEntry;
  onCopy: (value: string, key: string, label: string) => Promise<void>;
}) {
  const isAvailable = Boolean(entry.value);

  return (
    <div className="rounded-[1.3rem] border border-border/35 bg-background/35 px-4 py-4 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
            {entry.label}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p
              className={cn(
                "break-all font-mono text-xs sm:text-sm",
                isAvailable ? "text-foreground/90" : "text-muted-foreground/55",
              )}
            >
              {entry.value ?? "Not available in this connection mode."}
            </p>
            <Badge variant="outline" className="border-border/40 bg-background/40 text-[10px] text-muted-foreground/75">
              {entry.network}
            </Badge>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-10 rounded-2xl border-border/40 bg-background/50 px-3"
          disabled={!entry.value}
          onClick={() => {
            if (!entry.value) {
              return;
            }

            void onCopy(entry.value, entry.id, entry.label);
          }}
        >
          {copiedKey === entry.id ? (
            <Check className="h-4 w-4 text-emerald-400" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground/70">
        {entry.description}
      </p>
    </div>
  );
}

export function ProfileHubPage() {
  const {
    arcWallet,
    authMethod,
    loginMethodLabel,
    logout,
    primaryWallet,
    sepoliaWallet,
    solanaWallet,
    userEmail,
  } = useCircleWallet();
  const {
    activeWalletAddress,
    activeWalletChainName,
    activeWalletLabel,
    activeWalletShortAddress,
    externalConnectorName,
    isActiveWalletConnected,
    walletMode,
  } = useHybridWallet();
  const { disconnect } = useDisconnect();
  const { toast } = useToast();

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const profileScopeId = useMemo(() => {
    if (walletMode === "circle") {
      return `circle:${arcWallet?.address ?? primaryWallet?.address ?? userEmail ?? "guest"}`;
    }

    return `external:${activeWalletAddress ?? externalConnectorName ?? "guest"}`;
  }, [
    activeWalletAddress,
    arcWallet?.address,
    externalConnectorName,
    primaryWallet?.address,
    userEmail,
    walletMode,
  ]);

  const { preferences, savePreferences } = useProfilePreferences(profileScopeId);

  const ownerAddresses = useMemo(() => {
    const evmAddresses =
      walletMode === "circle"
        ? [arcWallet?.address, sepoliaWallet?.address, primaryWallet?.address]
        : [activeWalletAddress];

    return Array.from(
      new Set(
        evmAddresses
          .filter((address): address is string => typeof address === "string")
          .map((address) => address.toLowerCase() as Address),
      ),
    );
  }, [activeWalletAddress, arcWallet?.address, primaryWallet?.address, sepoliaWallet?.address, walletMode]);

  const { candidateDomains, errorMessage, isLoading: isAnsLoading, ownedDomains, primaryDomain } =
    useProfileAnsDomains(ownerAddresses);

  const shortEmailHandle = useMemo(() => {
    if (!userEmail) {
      return null;
    }

    const localPart = userEmail.split("@")[0]?.trim();
    return localPart ? localPart.slice(0, 24) : null;
  }, [userEmail]);

  const manualIdentity = preferences.customIdentity || null;
  const socialHandle = preferences.xHandle || null;
  const displayIdentity =
    primaryDomain ?? manualIdentity ?? shortEmailHandle ?? activeWalletShortAddress ?? "WizPay account";

  const connectionType = walletMode === "circle" ? "Circle Wallet" : "External Wallet";
  const connectionDetail =
    walletMode === "circle"
      ? authMethod === "google"
        ? "Google authenticated"
        : authMethod === "email"
          ? "Email authenticated"
          : authMethod === "passkey"
            ? "Passkey secured"
            : "App wallet session"
      : `${externalConnectorName ?? "Wallet"} connected`;

  const addressEntries = useMemo<AddressEntry[]>(() => {
    if (walletMode === "circle") {
      return [
        {
          id: "arc",
          label: "EVM address",
          network: "Arc Testnet",
          value: arcWallet?.address ?? primaryWallet?.address ?? null,
          description:
            "Primary app wallet address for Arc transactions, treasury flows, and ANS ownership.",
        },
        {
          id: "sepolia",
          label: "Secondary EVM",
          network: "Ethereum Sepolia",
          value: sepoliaWallet?.address ?? null,
          description:
            "Available when your Circle account has a Sepolia wallet ready for testing or bridging flows.",
        },
        {
          id: "solana",
          label: "Solana address",
          network: "Solana Devnet",
          value: solanaWallet?.address ?? null,
          description:
            "Use this address when funds or bridge destinations need a managed Solana endpoint inside WizPay.",
        },
      ];
    }

    return [
      {
        id: "external",
        label: "EVM address",
        network: activeWalletChainName ?? "Active chain",
        value: activeWalletAddress ?? null,
        description:
          "The currently connected external wallet address that signs this active session.",
      },
      {
        id: "solana",
        label: "Solana address",
        network: "Unavailable",
        value: null,
        description:
          "External EVM mode does not expose a managed Solana address. Switch to Circle Wallet when you need one.",
      },
    ];
  }, [
    activeWalletAddress,
    activeWalletChainName,
    arcWallet?.address,
    primaryWallet?.address,
    sepoliaWallet?.address,
    solanaWallet?.address,
    walletMode,
  ]);

  const walletBadges = useMemo(() => {
    const badges = [
      connectionType,
      isActiveWalletConnected ? "Connected" : "Disconnected",
      activeWalletChainName ?? "Chain pending",
    ];

    if (walletMode === "circle") {
      badges.push(loginMethodLabel);
      if (solanaWallet?.address) {
        badges.push("Solana ready");
      }
    } else if (externalConnectorName) {
      badges.push(externalConnectorName);
    }

    if (primaryDomain) {
      badges.push("ANS primary");
    }

    return Array.from(new Set(badges.filter(Boolean)));
  }, [
    activeWalletChainName,
    connectionType,
    externalConnectorName,
    isActiveWalletConnected,
    loginMethodLabel,
    primaryDomain,
    solanaWallet?.address,
    walletMode,
  ]);

  async function handleCopy(value: string, key: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      toast({
        title: `${label} copied`,
        description: "The address is ready to paste into another wallet, faucet, or bridge flow.",
      });
      window.setTimeout(() => setCopiedKey(null), 1800);
    } catch (error) {
      console.error(error);
      toast({
        title: "Copy failed",
        description: "Your browser blocked clipboard access for this action.",
      });
    }
  }

  function handleSaveCustomIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const savedPreferences = savePreferences({
      customIdentity: String(formData.get("customIdentity") ?? ""),
    });

    toast({
      title: "Custom identity saved",
      description:
        savedPreferences.customIdentity
          ? `WizPay will use ${savedPreferences.customIdentity} as your fallback display identity on this device.`
          : "Your fallback custom identity has been cleared.",
    });
  }

  function handleSaveSocialIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const savedPreferences = savePreferences({
      xHandle: String(formData.get("xHandle") ?? ""),
    });

    toast({
      title: "Social identity saved",
      description:
        savedPreferences.xHandle
          ? `@${savedPreferences.xHandle} is now stored for this wallet scope.`
          : "The saved X identity has been cleared.",
    });
  }

  function handleDisconnect() {
    if (walletMode === "circle") {
      logout();
      return;
    }

    disconnect();
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <section className="glass-card glow-card relative overflow-hidden rounded-[2rem] px-5 py-5 sm:px-7 sm:py-7">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-32 w-32 rounded-full bg-primary/15 blur-3xl" />
          <div className="absolute bottom-0 right-0 h-36 w-36 rounded-full bg-cyan-400/10 blur-3xl" />
        </div>

        <div className="relative flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-3">
              <Badge className="w-fit gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-[10px] uppercase tracking-[0.24em] text-primary">
                <Sparkles className="h-3 w-3" />
                Web3 identity hub
              </Badge>

              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  {displayIdentity}
                </h1>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground/78 sm:text-base">
                  {primaryDomain
                    ? `${activeWalletShortAddress ?? connectionDetail} · ${connectionDetail}. This profile surface centralizes wallet identity, address copying, ANS, and social metadata in one place.`
                    : `${connectionDetail}. Keep wallet identity, copyable addresses, ANS names, and social metadata organized in one native-style account center.`}
                </p>
              </div>
            </div>

            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.5rem] border border-primary/20 bg-gradient-to-br from-primary/20 to-cyan-400/10 text-primary shadow-xl shadow-primary/10">
              <User className="h-7 w-7 icon-glow" />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {walletBadges.map((badge) => (
              <Badge
                key={badge}
                variant="outline"
                className="rounded-full border-border/40 bg-background/35 px-3 py-1 text-[11px] text-foreground/80"
              >
                {badge}
              </Badge>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryTile
              label="Connection"
              value={isActiveWalletConnected ? "Live" : "Offline"}
              hint={connectionType}
            />
            <SummaryTile
              label="Active chain"
              value={activeWalletChainName ?? "Not set"}
              hint={activeWalletLabel}
            />
            <SummaryTile
              label="Short identity"
              value={activeWalletShortAddress ?? "Pending"}
              hint={userEmail ?? (primaryDomain ? "ANS is active" : "Identity fallback in use")}
            />
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
        <Card className="glass-card border-border/40 rounded-[1.8rem] bg-card/70 py-0">
          <CardHeader className="border-b border-border/30 px-5 py-5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <WalletCards className="h-5 w-5 text-primary" />
              Wallet surface
            </CardTitle>
            <CardDescription className="text-sm text-muted-foreground/75">
              {walletMode === "circle"
                ? "Circle Wallet exposes the managed Arc, secondary EVM, and Solana surfaces available in this session."
                : "External wallet mode mirrors the currently connected EVM wallet while preserving the standard signing flow."}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4 px-5 py-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[1.4rem] border border-border/35 bg-background/35 px-4 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                  Connection type
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <BadgeCheck className="h-4 w-4 text-emerald-400" />
                  <p className="text-base font-semibold text-foreground">{connectionType}</p>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground/75">
                  {connectionDetail}
                </p>
              </div>

              <div className="rounded-[1.4rem] border border-border/35 bg-background/35 px-4 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                  Active chain
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Network className="h-4 w-4 text-cyan-300" />
                  <p className="text-base font-semibold text-foreground">
                    {activeWalletChainName ?? "Not set"}
                  </p>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground/75">
                  {walletMode === "circle"
                    ? "App wallet sessions default to the managed Arc execution surface unless another connected Circle wallet is shown here."
                    : "External mode always reflects the current EVM connector chain reported by the active wallet."}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {addressEntries.map((entry) => (
                <AddressItem
                  key={entry.id}
                  copiedKey={copiedKey}
                  entry={entry}
                  onCopy={handleCopy}
                />
              ))}
            </div>

            <div className="flex flex-col gap-3 rounded-[1.4rem] border border-border/35 bg-background/30 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                  Session metadata
                </p>
                <div className="mt-2 space-y-1 text-sm text-foreground/85">
                  {userEmail ? (
                    <p className="flex items-center gap-2 break-all">
                      <Mail className="h-4 w-4 text-primary" />
                      {userEmail}
                    </p>
                  ) : null}
                  <p className="flex items-center gap-2 break-all text-muted-foreground/80">
                    <Link2 className="h-4 w-4 text-cyan-300" />
                    {activeWalletShortAddress ?? "Wallet not connected"}
                  </p>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-2xl border-border/40 bg-background/45 px-4 text-sm"
                onClick={handleDisconnect}
              >
                <span className="flex items-center gap-2">
                  <LogOut className="h-4 w-4" />
                  {walletMode === "circle" ? "Log out Circle Wallet" : "Disconnect wallet"}
                </span>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card border-border/40 rounded-[1.8rem] bg-card/70 py-0">
          <CardHeader className="border-b border-border/30 px-5 py-5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <AtSign className="h-5 w-5 text-primary" />
              ANS identity
            </CardTitle>
            <CardDescription className="text-sm text-muted-foreground/75">
              WizPay checks the exact ANS names tracked or registered in this browser and verifies live ownership against the registrar.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4 px-5 py-5">
            {isAnsLoading && candidateDomains.length > 0 ? (
              <div className="rounded-[1.4rem] border border-border/35 bg-background/35 px-4 py-4">
                <p className="text-sm font-semibold text-foreground">Checking ANS ownership</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground/75">
                  Re-validating locally tracked ANS names against the latest contract state.
                </p>
              </div>
            ) : null}

            {primaryDomain ? (
              <>
                <div className="rounded-[1.5rem] border border-primary/20 bg-gradient-to-br from-primary/12 to-cyan-400/8 px-4 py-4 shadow-lg shadow-primary/5">
                  <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-primary/85">
                    Primary ANS identity
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <BadgeCheck className="h-5 w-5 text-emerald-400" />
                    <p className="text-xl font-semibold tracking-tight text-foreground">
                      {primaryDomain}
                    </p>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground/78">
                    This domain is the strongest on-device identity signal available for the current wallet scope.
                  </p>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                    Verified domains
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ownedDomains.map((lookup) => (
                      <Badge
                        key={lookup.target.domain}
                        variant="outline"
                        className="rounded-full border-border/40 bg-background/40 px-3 py-1 text-[11px] text-foreground/85"
                      >
                        {lookup.target.domain}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button asChild className="glow-btn h-11 flex-1 rounded-2xl bg-gradient-to-r from-primary to-violet-500 text-primary-foreground">
                    <Link href="/ans/my-domains">
                      <span className="flex items-center gap-2">
                        Manage domains
                        <ExternalLink className="h-4 w-4" />
                      </span>
                    </Link>
                  </Button>
                  <Button asChild variant="outline" className="h-11 flex-1 rounded-2xl border-border/40 bg-background/45">
                    <Link href="/ans/register">Register ANS</Link>
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-4 rounded-[1.5rem] border border-border/35 bg-background/35 px-4 py-4">
                <div>
                  <p className="text-base font-semibold text-foreground">No ANS identity detected</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground/75">
                    Until indexing exists, WizPay can only auto-detect exact ANS names that were tracked or registered from this device for the current wallet scope.
                  </p>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button asChild className="glow-btn h-11 flex-1 rounded-2xl bg-gradient-to-r from-primary to-violet-500 text-primary-foreground">
                    <Link href="/ans/register">Register ANS</Link>
                  </Button>
                  <Button asChild variant="outline" className="h-11 flex-1 rounded-2xl border-border/40 bg-background/45">
                    <Link href="#manual-identity">Add custom identity manually</Link>
                  </Button>
                </div>

                {errorMessage ? (
                  <p className="text-xs leading-5 text-amber-300/85">{errorMessage}</p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          id="manual-identity"
          className="glass-card border-border/40 rounded-[1.8rem] bg-card/70 py-0"
        >
          <CardHeader className="border-b border-border/30 px-5 py-5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <User className="h-5 w-5 text-primary" />
              Custom identity
            </CardTitle>
            <CardDescription className="text-sm text-muted-foreground/75">
              Use a manual identity label until you have a primary ANS name. This stays scoped to the current wallet context on this device.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4 px-5 py-5">
            {manualIdentity ? (
              <div className="rounded-[1.4rem] border border-border/35 bg-background/35 px-4 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                  Saved fallback identity
                </p>
                <p className="mt-2 text-lg font-semibold text-foreground">{manualIdentity}</p>
              </div>
            ) : null}

            <form
              key={`${profileScopeId}:${preferences.updatedAt ?? "0"}:custom`}
              className="space-y-4"
              onSubmit={handleSaveCustomIdentity}
            >
              <div className="space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                  Manual name
                </p>
                <Input
                  name="customIdentity"
                  defaultValue={preferences.customIdentity}
                  placeholder="Treasury Desk"
                  className="h-11 rounded-2xl border-border/40 bg-background/45 px-4"
                />
              </div>

              <Button
                type="submit"
                variant="outline"
                className="h-11 rounded-2xl border-border/40 bg-background/45 px-4"
              >
                Save manual identity
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="glass-card border-border/40 rounded-[1.8rem] bg-card/70 py-0">
          <CardHeader className="border-b border-border/30 px-5 py-5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Globe2 className="h-5 w-5 text-primary" />
              Social identity
            </CardTitle>
            <CardDescription className="text-sm text-muted-foreground/75">
              Store an X or Twitter handle now. The data model is local-first and modular so OAuth can be added later without changing this UI surface.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4 px-5 py-5">
            {socialHandle ? (
              <div className="rounded-[1.4rem] border border-border/35 bg-background/35 px-4 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                  Saved X handle
                </p>
                <p className="mt-2 text-lg font-semibold text-foreground">@{socialHandle}</p>
              </div>
            ) : null}

            <form
              key={`${profileScopeId}:${preferences.updatedAt ?? "0"}:social`}
              className="space-y-4"
              onSubmit={handleSaveSocialIdentity}
            >
              <div className="rounded-[1.4rem] border border-border/35 bg-background/35 px-4 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/65">
                  X username
                </p>
                <div className="mt-2 flex items-center gap-3 rounded-2xl border border-border/35 bg-background/50 px-4">
                  <span className="text-sm font-semibold text-primary">@</span>
                  <Input
                    name="xHandle"
                    defaultValue={preferences.xHandle}
                    placeholder="deseti"
                    className="h-11 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                  />
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground/75">
                  Works for Circle Wallet and external wallet users. OAuth is intentionally deferred until the identity layer is ready.
                </p>
              </div>

              <Button
                type="submit"
                className="glow-btn h-11 rounded-2xl bg-gradient-to-r from-primary to-violet-500 text-primary-foreground"
              >
                Save social identity
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}