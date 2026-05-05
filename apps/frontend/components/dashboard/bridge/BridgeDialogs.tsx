"use client";

import {
  CheckCircle2,
  ExternalLink,
  MessageCircle,
  RefreshCw,
  Route,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CircleTransfer, CircleTransferBlockchain } from "@/lib/transfer-service";
import { buildXShareUrl } from "@/lib/social";
import { getEstimatedBridgeTimeLabel, hasExplorerTxHash, shortenAddress, getOptionByChain } from "./bridge-utils";
import { BRIDGE_ASSET_SYMBOL } from "./bridge-types";

// ─── Review dialog ────────────────────────────────────────────────────────────

interface BridgeReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSubmitting: boolean;
  isExternalBridgeMode: boolean;
  externalBridgeRouteKind: "evm-to-evm" | "evm-to-solana" | "solana-to-evm" | "solana-to-solana";
  sourceOption: { id: CircleTransferBlockchain; label: string };
  destinationOption: { id: CircleTransferBlockchain; label: string };
  amount: string;
  destinationAddress: string;
  transferWalletAddress: string | undefined;
  externalWalletAddress: string | undefined;
  solanaWalletAddress: string | null;
  solanaWalletLabel: string;
  onSubmit: () => void;
}

export function BridgeReviewDialog({
  open,
  onOpenChange,
  isSubmitting,
  isExternalBridgeMode,
  externalBridgeRouteKind,
  sourceOption,
  destinationOption,
  amount,
  destinationAddress,
  transferWalletAddress,
  externalWalletAddress,
  solanaWalletAddress,
  solanaWalletLabel,
  onSubmit,
}: BridgeReviewDialogProps) {
  const tokenSymbol = BRIDGE_ASSET_SYMBOL;
  const externalDescription =
    externalBridgeRouteKind === "evm-to-solana"
      ? "Your EVM wallet signs the approval and burn, then your Solana wallet signs the destination mint. Keep both wallet extensions open until the route completes."
      : externalBridgeRouteKind === "solana-to-evm"
        ? "Your Solana wallet signs the burn, then your EVM wallet signs the destination mint. Keep both wallet extensions open until the route completes."
        : externalBridgeRouteKind === "solana-to-solana"
          ? "External wallet mode does not support Solana to Solana bridges yet."
          : "Your external EVM wallet will sign 3 transactions: USDC approve, burn, and destination mint. Keep your wallet extension open until the route completes.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
        <div className="relative overflow-hidden p-6">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary ring-1 ring-primary/20">
            <Route className="h-7 w-7" />
          </div>
          <DialogHeader className="space-y-2">
            <DialogTitle className="text-xl">Review bridge transfer</DialogTitle>
            <DialogDescription>
              {isExternalBridgeMode
                ? externalDescription
                : `This bridge will first open Circle Wallet so you can approve a deposit from your personal ${sourceOption.label} wallet into the selected source treasury wallet. After that deposit is confirmed, the backend treasury wallet completes the bridge.`}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Route</span>
                <span className="font-medium">
                  {sourceOption.label} to {destinationOption.label}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Amount</span>
                <span className="font-mono font-medium">
                  {amount || "0"} {tokenSymbol}
                </span>
              </div>
              <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Destination</span>
                <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                  {destinationAddress || "Unavailable"}
                </span>
              </div>
              {isExternalBridgeMode ? (
                <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                  <span className="text-muted-foreground/70">EVM wallet</span>
                  <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                    {externalWalletAddress || "Unavailable"}
                  </span>
                </div>
              ) : (
                <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                  <span className="text-muted-foreground/70">
                    Source treasury wallet
                  </span>
                  <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                    {transferWalletAddress || "Unavailable"}
                  </span>
                </div>
              )}
              {isExternalBridgeMode &&
              (externalBridgeRouteKind === "evm-to-solana" ||
                externalBridgeRouteKind === "solana-to-evm") ? (
                <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                  <span className="text-muted-foreground/70">{solanaWalletLabel}</span>
                  <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                    {solanaWalletAddress || "Unavailable"}
                  </span>
                </div>
              ) : null}
            </div>

            {isExternalBridgeMode ? (
              <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 text-sm">
                <p className="font-semibold text-primary/80 mb-2">
                  {externalBridgeRouteKind === "solana-to-evm"
                    ? "2 wallet confirmations required"
                    : "3 wallet confirmations required"}
                </p>
                <ol className="space-y-1 text-muted-foreground/80 list-none">
                  {externalBridgeRouteKind === "evm-to-solana" ? (
                    <>
                      <li>① Approve USDC spend in your EVM wallet on {sourceOption.label}</li>
                      <li>② Burn USDC via CCTP V2 in your EVM wallet on {sourceOption.label}</li>
                      <li>③ Mint USDC in your Solana wallet on {destinationOption.label}</li>
                    </>
                  ) : externalBridgeRouteKind === "solana-to-evm" ? (
                    <>
                      <li>① Burn USDC via CCTP V2 in your Solana wallet on {sourceOption.label}</li>
                      <li>② Mint USDC in your EVM wallet on {destinationOption.label}</li>
                    </>
                  ) : (
                    <>
                      <li>① Approve USDC spend on {sourceOption.label}</li>
                      <li>② Burn USDC via CCTP V2 on {sourceOption.label}</li>
                      <li>③ Mint USDC on {destinationOption.label} (auto-switched)</li>
                    </>
                  )}
                </ol>
                <p className="mt-2 text-xs text-muted-foreground/60">
                  Estimated time:{" "}
                  {getEstimatedBridgeTimeLabel(sourceOption.id, true)} including
                  Circle attestation.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                Circle burn, attestation, and mint can take a while. The
                progress tracker will keep updating after you submit, and you
                can leave the page at any time.
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={onSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Route className="h-4 w-4" />
                )}
                {isSubmitting ? "Starting bridge..." : "Start bridge"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Success dialog ───────────────────────────────────────────────────────────

interface BridgeSuccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transfer: CircleTransfer | null;
  tokenSymbol: string;
  onStartNew: () => void;
}

export function BridgeSuccessDialog({
  open,
  onOpenChange,
  transfer,
  tokenSymbol,
  onStartNew,
}: BridgeSuccessDialogProps) {
  if (!transfer) return null;

  const transferSourceOption = getOptionByChain(transfer.sourceBlockchain);
  const transferDestinationOption = getOptionByChain(transfer.blockchain);

  const burnStep = transfer.steps.find((s) => s.id === "burn");
  const mintStep = transfer.steps.find((s) => s.id === "mint");
  const burnExplorerUrl = hasExplorerTxHash(burnStep?.explorerUrl)
    ? burnStep?.explorerUrl
    : null;
  const mintExplorerUrl = hasExplorerTxHash(mintStep?.explorerUrl)
    ? mintStep?.explorerUrl
    : null;
  const shareBridgeUrl = mintExplorerUrl ?? burnExplorerUrl;

  const bridgeXShareUrl = buildXShareUrl({
    summary: `Bridge completed on WizPay: ${transfer.amount} ${tokenSymbol} from ${transferSourceOption.label} to ${transferDestinationOption.label}.`,
    explorerUrl: shareBridgeUrl,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
        <div className="relative overflow-hidden p-6">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-400 ring-1 ring-emerald-400/20">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <DialogHeader className="space-y-2">
            <DialogTitle className="text-xl">Bridge completed</DialogTitle>
            <DialogDescription>
              Circle finished the bridge and the destination mint is confirmed.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Route</span>
                <span className="font-medium">
                  {transferSourceOption.label} to {transferDestinationOption.label}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Amount</span>
                <span className="font-mono font-medium">
                  {transfer.amount} {tokenSymbol}
                </span>
              </div>
              <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Destination</span>
                <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                  {transfer.destinationAddress || "Unavailable"}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Transfer ID</span>
                <span className="font-mono text-xs">
                  {shortenAddress(transfer.transferId)}
                </span>
              </div>
            </div>

            <div className="grid gap-2">
              {burnExplorerUrl ? (
                <Button asChild variant="outline" className="w-full">
                  <a href={burnExplorerUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    View burn tx
                  </a>
                </Button>
              ) : null}
              {mintExplorerUrl ? (
                <Button asChild variant="outline" className="w-full">
                  <a href={mintExplorerUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    View mint tx
                  </a>
                </Button>
              ) : null}
            </div>

            <Button
              variant="outline"
              className="w-full gap-2 border-[#1DA1F2]/50 text-[#1DA1F2] hover:bg-[#1DA1F2]/10"
              asChild
            >
              <a href={bridgeXShareUrl} target="_blank" rel="noreferrer">
                <MessageCircle className="h-4 w-4" />
                Share to X (Twitter)
              </a>
            </Button>

            <Button className="w-full" onClick={onStartNew}>
              Start New Bridge
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
