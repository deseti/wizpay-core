"use client";

import {
  Check,
  Copy,
  Droplet,
  ExternalLink,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CircleTransfer, CircleTransferWallet } from "@/lib/transfer-service";
import type { CircleTransferBlockchain, DestinationWalletMap } from "./bridge-types";
import {
  APP_TREASURY_WALLET_TITLE,
  APP_TREASURY_WALLET_LABEL,
  BRIDGE_ASSET_SYMBOL,
} from "./bridge-types";
import {
  formatWalletBalance,
  getTransferStatusLabel,
  getOptionByChain,
  hasExplorerTxHash,
  shortenAddress,
  getLastUpdatedLabel,
} from "./bridge-utils";

interface BridgeRightPanelProps {
  // Treasury wallet section
  transferWallet: CircleTransferWallet | null;
  walletStatusError: string | null;
  isWalletLoading: boolean;
  isWalletBootstrapping: boolean;
  sourceOption: { id: CircleTransferBlockchain; label: string };
  tokenSymbol: string;
  onRefreshTreasuryWallet: () => void;
  onBootstrapWallet: () => void;

  // Destination wallets section
  arcWalletAddress: string | undefined;
  sepoliaWalletAddress: string | undefined;
  solanaWalletAddress: string | undefined;
  destinationWallets: DestinationWalletMap;
  isDestinationWalletsLoading: boolean;
  isPasskeyWalletSession: boolean;
  copiedWallet: string | null;
  passkeySolanaInput: string;
  onCopyWalletAddress: (address: string, key: string) => void;
  onPasskeySolanaInputChange: (value: string) => void;
  onSavePasskeySolana: () => void;
  onRefreshDestinationWallets: () => void;

  // Transfer status section
  transfer: CircleTransfer | null;
}

export function BridgeRightPanel({
  transferWallet,
  walletStatusError,
  isWalletLoading,
  isWalletBootstrapping,
  sourceOption,
  tokenSymbol,
  onRefreshTreasuryWallet,
  onBootstrapWallet,
  arcWalletAddress,
  sepoliaWalletAddress,
  solanaWalletAddress,
  destinationWallets,
  isDestinationWalletsLoading,
  isPasskeyWalletSession,
  copiedWallet,
  passkeySolanaInput,
  onCopyWalletAddress,
  onPasskeySolanaInputChange,
  onSavePasskeySolana,
  onRefreshDestinationWallets,
  transfer,
}: BridgeRightPanelProps) {
  const treasuryWalletOption = transferWallet
    ? getOptionByChain(transferWallet.blockchain)
    : sourceOption;

  const transferSourceOption = transfer
    ? getOptionByChain(transfer.sourceBlockchain)
    : sourceOption;
  const transferDestinationOption = transfer
    ? getOptionByChain(transfer.blockchain)
    : sourceOption;

  // Explorer URLs for transfer status section
  const burnExplorerUrl = (() => {
    const burnStep = transfer?.steps.find((s) => s.id === "burn");
    return hasExplorerTxHash(burnStep?.explorerUrl) ? burnStep?.explorerUrl : null;
  })();
  const mintExplorerUrl = (() => {
    const mintStep = transfer?.steps.find((s) => s.id === "mint");
    return hasExplorerTxHash(mintStep?.explorerUrl) ? mintStep?.explorerUrl : null;
  })();

  return (
    <div className="space-y-4">
      {/* ── Source treasury wallet ──────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
              {APP_TREASURY_WALLET_TITLE}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              App-owned Circle developer-controlled wallet on the selected
              source network. This is not your personal wallet.
            </p>
          </div>
          {isWalletLoading || isWalletBootstrapping ? (
            <RefreshCw className="mt-0.5 h-4 w-4 animate-spin text-muted-foreground/60" />
          ) : null}
        </div>

        {transferWallet ? (
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Network</span>
              <span className="font-medium">{treasuryWalletOption.label}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Asset</span>
              <span className="font-medium">USDC only</span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground/70">Address</span>
              <span className="max-w-[11rem] break-all text-right font-mono text-xs">
                {transferWallet.walletAddress}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Balance</span>
              <span className="font-medium">
                {formatWalletBalance(transferWallet, tokenSymbol)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Circle Wallet ID</span>
              <span className="font-mono text-xs">
                {shortenAddress(transferWallet.walletId)}
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground/70">
            {walletStatusError ||
              `No ${APP_TREASURY_WALLET_LABEL} is ready for ${sourceOption.label} yet. Initialize it below and fund it with ${tokenSymbol}.`}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onRefreshTreasuryWallet}
            disabled={isWalletLoading || isWalletBootstrapping}
            className="w-full"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh treasury wallet
          </Button>
          {!transferWallet ? (
            <Button
              size="sm"
              onClick={onBootstrapWallet}
              disabled={isWalletLoading || isWalletBootstrapping}
              className="w-full"
            >
              {isWalletBootstrapping ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Wallet className="h-4 w-4" />
              )}
              Initialize treasury wallet
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline" className="w-full">
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              <Droplet className="h-4 w-4" />
              Open Circle faucet
            </a>
          </Button>
          <p className="text-xs text-muted-foreground/70">
            Fund this wallet with testnet USDC before starting the bridge.
          </p>
        </div>
      </div>

      {/* ── Your destination wallets ────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
          Your destination wallets
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          These are your personal Circle wallets across Arc, Sepolia, and
          Solana Devnet.
        </p>

        <div className="mt-3 space-y-3 text-sm">
          {(
            [
              {
                key: "arc" as const,
                label: "Arc Testnet",
                address:
                  arcWalletAddress ||
                  destinationWallets["ARC-TESTNET"]?.walletAddress,
              },
              {
                key: "sepolia" as const,
                label: "Ethereum Sepolia",
                address:
                  sepoliaWalletAddress ||
                  destinationWallets["ETH-SEPOLIA"]?.walletAddress,
              },
            ] as const
          ).map(({ key, label, address }) => (
            <div key={key} className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <Wallet className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{label}</p>
                <p className="font-mono text-xs text-muted-foreground/70 truncate">
                  {shortenAddress(address)}
                </p>
              </div>
              {address ? (
                <button
                  onClick={() => onCopyWalletAddress(address, key)}
                  className="shrink-0 rounded-lg p-1.5 transition-colors hover:bg-primary/10"
                  title={`Copy ${label} address`}
                >
                  {copiedWallet === key ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              ) : null}
            </div>
          ))}

          {/* Solana Devnet row */}
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Wallet className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium">Solana Devnet</p>
              {solanaWalletAddress ? (
                <div className="flex items-center gap-1">
                  <p className="font-mono text-xs text-muted-foreground/70 truncate">
                    {shortenAddress(solanaWalletAddress)}
                  </p>
                  <button
                    onClick={() =>
                      onCopyWalletAddress(solanaWalletAddress, "solana")
                    }
                    className="shrink-0 rounded-lg p-1 transition-colors hover:bg-primary/10"
                    title="Copy Solana address"
                  >
                    {copiedWallet === "solana" ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </div>
              ) : isPasskeyWalletSession ? (
                <div className="mt-1 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground/70">
                    Passkey sessions don&apos;t have a Solana wallet. Enter
                    your Solana address to save it.
                  </p>
                  <div className="flex gap-1.5">
                    <Input
                      value={passkeySolanaInput}
                      onChange={(e) => onPasskeySolanaInputChange(e.target.value)}
                      placeholder="Solana address…"
                      className="h-7 text-xs font-mono"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onSavePasskeySolana();
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onSavePasskeySolana}
                      disabled={!passkeySolanaInput.trim()}
                      className="h-7 px-2 text-xs"
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="font-mono text-xs text-muted-foreground/70">—</p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={onRefreshDestinationWallets}
            disabled={isDestinationWalletsLoading}
            className="w-full"
          >
            <RefreshCw
              className={`h-4 w-4 ${isDestinationWalletsLoading ? "animate-spin" : ""}`}
            />
            Refresh destination wallets
          </Button>
        </div>
      </div>

      {/* ── Transfer status ─────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
          Transfer status
        </p>
        {transfer ? (
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Status</span>
              <span className="font-medium">
                {getTransferStatusLabel(transfer)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Route</span>
              <span className="font-medium">
                {transferSourceOption.label} to {transferDestinationOption.label}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Transfer ID</span>
              <span className="font-mono text-xs">
                {shortenAddress(transfer.transferId)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Destination</span>
              <span className="font-mono text-xs">
                {shortenAddress(transfer.destinationAddress)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Provider</span>
              <span className="font-medium">
                {transfer.provider || "Circle Bridge Kit"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground/70">Last updated</span>
              <span className="font-medium">
                {getLastUpdatedLabel(transfer.updatedAt)}
              </span>
            </div>

            {burnExplorerUrl || mintExplorerUrl ? (
              <div className="grid gap-2">
                {burnExplorerUrl ? (
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="w-full"
                  >
                    <a
                      href={burnExplorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                      View burn tx
                    </a>
                  </Button>
                ) : null}
                {mintExplorerUrl ? (
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="w-full"
                  >
                    <a
                      href={mintExplorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                      View mint tx
                    </a>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground/70">
            No bridge submitted yet.
          </p>
        )}
      </div>
    </div>
  );
}
