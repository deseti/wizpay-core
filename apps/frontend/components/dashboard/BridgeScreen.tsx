"use client";

import { Clock3, RefreshCw, Route } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  getTreasuryFundingMessage,
  isPositiveDecimal,
  shortenAddress,
} from "./bridge/bridge-utils";
import { BridgeProgressCard } from "./bridge/BridgeProgressCard";
import { BridgeRightPanel } from "./bridge/BridgeRightPanel";
import {
  BridgeReviewDialog,
  BridgeSuccessDialog,
} from "./bridge/BridgeDialogs";
import { useBridgeScreen } from "./bridge/useBridgeScreen";

export function BridgeScreen() {
  const {
    sourceChain,
    destinationChain,
    amount,
    setAmount,
    destinationAddress,
    setDestinationAddress,
    transfer,
    transferWallet,
    errorMessage,
    walletStatusError,
    isSubmitting,
    isWalletLoading,
    isWalletBootstrapping,
    isPollingTransfer,
    isReconnectingToTracking,
    isReviewDialogOpen,
    setIsReviewDialogOpen,
    isSuccessDialogOpen,
    setIsSuccessDialogOpen,
    destinationWallets,
    isDestinationWalletsLoading,
    copiedWallet,
    passkeySolanaInput,
    setPasskeySolanaInput,
    tokenSymbol,
    sourceOption,
    destinationOption,
    isSameChainRoute,
    isPasskeyWalletSession,
    isPasskeyUnsupportedSource,
    passkeySourceRestrictionMessage,
    isExternalBridgeMode,
    isExternalEvmBridge,
    externalBridgeModeMessage,
    externalUsdcBalanceLabel,
    hasEnoughExternalUsdc,
    treasuryWalletEmpty,
    hasSufficientWalletBalance,
    isTransferActive,
    estimatedTimeLabel,
    sourceChainOptions,
    destinationChainOptions,
    canRetryExternalAttestation,
    isDestinationSolana,
    externalWalletAddress,
    externalWalletChainId,
    sourceChainId,
    arcWalletAddress,
    sepoliaWalletAddress,
    solanaWalletAddress,
    handleSourceChainChange,
    handleDestinationChainChange,
    dismissTransfer,
    refreshTransferWallet,
    copyWalletAddress,
    handleSavePasskeySolana,
    refreshDestinationWallets,
    handleBootstrapWallet,
    openBridgeReview,
    submitBridge,
    retryAttestation,
    handleStartNew,
  } = useBridgeScreen();

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-up space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Bridge
          </h1>
          <p className="text-sm text-muted-foreground/70">
            Circle CCTP flow that first asks your personal Circle wallet to
            fund the source treasury, then forwards testnet USDC across Arc,
            Sepolia, and Solana Devnet.
          </p>
        </div>
      </div>

      <Card className="glass-card overflow-hidden border-border/40">
        <CardHeader className="relative overflow-hidden border-b border-border/30 pb-5">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
          <CardTitle className="flex items-center gap-2 text-xl">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Route className="h-4.5 w-4.5" />
            </div>
            User-Confirmed Bridge
          </CardTitle>
          <CardDescription>
            Choose source and destination networks. WizPay will request a
            Circle wallet approval to move funds from your personal source
            wallet into the source treasury, then Circle burns on the selected
            source chain and mints on the selected destination chain.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 py-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          {/* ── Left column ── */}
          <div className="space-y-5">
            {/* Treasury model banner */}
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary/80">
                Treasury model
              </p>
              <p className="mt-2 text-sm text-muted-foreground/80">
                This bridge still uses an app-owned Circle developer-controlled
                treasury wallet on the selected source network, but it now
                starts with a Circle popup so you can approve a USDC deposit
                from your personal source wallet into that treasury wallet.
              </p>
            </div>

            {/* Mode-specific banners */}
            {isExternalBridgeMode && externalBridgeModeMessage ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                {externalBridgeModeMessage}
              </div>
            ) : isPasskeyUnsupportedSource ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                {passkeySourceRestrictionMessage}
              </div>
            ) : isExternalEvmBridge ? (
              <div className="space-y-3">
                <div className="rounded-2xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-primary/90">
                  External wallet mode: your connected wallet will sign each
                  CCTP V2 step directly (approve → burn → mint). No treasury
                  wallet required.
                </div>
                {externalWalletAddress ? (
                  <div className="rounded-2xl border border-border/40 bg-background/40 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground/70">
                        Connected wallet
                      </span>
                      <span className="font-mono text-xs">
                        {shortenAddress(externalWalletAddress)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-muted-foreground/70">
                        USDC balance ({sourceOption.label})
                      </span>
                      <span
                        className={`font-mono text-xs ${!hasEnoughExternalUsdc ? "text-destructive" : ""}`}
                      >
                        {externalUsdcBalanceLabel}
                      </span>
                    </div>
                    {externalWalletChainId &&
                    externalWalletChainId !== sourceChainId ? (
                      <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                        Wallet is on a different chain. It will auto-switch
                        when you start the bridge.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {isPositiveDecimal(amount) && !hasEnoughExternalUsdc ? (
                  <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    Insufficient USDC: wallet holds {externalUsdcBalanceLabel}{" "}
                    on {sourceOption.label}, but {amount} USDC is needed. Fund
                    the wallet before bridging.
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Active transfer progress */}
            {transfer ? (
              <BridgeProgressCard
                transfer={transfer}
                isPollingTransfer={isPollingTransfer}
                isSubmitting={isSubmitting}
                isReconnectingToTracking={isReconnectingToTracking}
                estimatedTimeLabel={estimatedTimeLabel}
                sourceOption={sourceOption}
                destinationOption={destinationOption}
                onDismiss={dismissTransfer}
                onRetryAttestation={retryAttestation}
              />
            ) : null}

            {/* Chain selectors */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Source network
                </label>
                <Select
                  value={sourceChain}
                  onValueChange={handleSourceChainChange}
                  disabled={isTransferActive || isSubmitting}
                >
                  <SelectTrigger className="h-11 border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceChainOptions
                      .filter((opt) => opt.id !== destinationChain)
                      .map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          {opt.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Destination network
                </label>
                <Select
                  value={destinationChain}
                  onValueChange={handleDestinationChainChange}
                  disabled={isTransferActive || isSubmitting}
                >
                  <SelectTrigger className="h-11 border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {destinationChainOptions
                      .filter((opt) => opt.id !== sourceChain)
                      .map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          {opt.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-2xl border border-border/30 bg-background/35 px-4 py-3 text-sm text-muted-foreground/80">
              Route: approve a deposit from your personal {sourceOption.label}{" "}
              wallet into the source treasury wallet, then burn from treasury
              and mint to your destination address on {destinationOption.label}.
            </div>

            {isSameChainRoute ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Source and destination network must be different.
              </div>
            ) : null}

            {/* Amount + destination address */}
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Amount
                </label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.000001"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="h-11 border-border/40 bg-background/50"
                  disabled={isTransferActive || isSubmitting}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Destination wallet
                </label>
                <Input
                  placeholder={
                    isDestinationSolana ? "Solana base58 address..." : "0x..."
                  }
                  value={destinationAddress}
                  onChange={(e) => setDestinationAddress(e.target.value)}
                  className="h-11 border-border/40 bg-background/50 font-mono text-xs"
                  disabled={isTransferActive || isSubmitting}
                />
              </div>
            </div>

            {errorMessage ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}

            {transferWallet &&
            treasuryWalletEmpty &&
            !isPositiveDecimal(amount) ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                Bridge requires USDC in the selected {sourceOption.label} source
                treasury wallet. If your funded wallet is on the other network,
                switch the source network above before bridging.
              </div>
            ) : null}

            {transferWallet &&
            !hasSufficientWalletBalance &&
            isPositiveDecimal(amount) ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                {getTreasuryFundingMessage({
                  networkLabel: sourceOption.label,
                  availableAmount: transferWallet.balance?.amount || "0",
                  symbol: transferWallet.balance?.symbol || tokenSymbol,
                  walletAddress: transferWallet.walletAddress,
                  requestedAmount: amount,
                })}
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="rounded-2xl border border-border/30 bg-background/40 px-4 py-3 text-sm text-muted-foreground/80">
                A Circle wallet popup appears before the bridge starts so you
                can approve the deposit from your personal source wallet into
                the selected source treasury wallet. After that confirmation,
                the backend treasury wallet executes the bridge.
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button
                  onClick={openBridgeReview}
                  disabled={
                    isSubmitting ||
                    isWalletLoading ||
                    isWalletBootstrapping ||
                    (isExternalBridgeMode && !isExternalEvmBridge)
                  }
                  className="h-11 px-5"
                >
                  {isSubmitting ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Route className="h-4 w-4" />
                  )}
                  {isSubmitting
                    ? "Starting bridge..."
                    : `Bridge ${tokenSymbol}`}
                </Button>
                {isTransferActive ? (
                  <p className="text-sm text-muted-foreground/70">
                    A bridge is already running. You can leave this page and
                    come back later while tracking continues.
                  </p>
                ) : isExternalBridgeMode && !isExternalEvmBridge ? (
                  <p className="text-sm text-muted-foreground/70">
                    External wallet mode is selected. Solana Devnet routes only
                    work with App Wallet (Circle). Switch wallet mode or use an
                    EVM route (Arc Testnet ↔ Ethereum Sepolia).
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── Right column ── */}
          <BridgeRightPanel
            transferWallet={transferWallet}
            walletStatusError={walletStatusError}
            isWalletLoading={isWalletLoading}
            isWalletBootstrapping={isWalletBootstrapping}
            sourceOption={sourceOption}
            tokenSymbol={tokenSymbol}
            onRefreshTreasuryWallet={() => void refreshTransferWallet()}
            onBootstrapWallet={() => void handleBootstrapWallet()}
            arcWalletAddress={arcWalletAddress}
            sepoliaWalletAddress={sepoliaWalletAddress}
            solanaWalletAddress={solanaWalletAddress}
            destinationWallets={destinationWallets}
            isDestinationWalletsLoading={isDestinationWalletsLoading}
            isPasskeyWalletSession={isPasskeyWalletSession}
            copiedWallet={copiedWallet}
            passkeySolanaInput={passkeySolanaInput}
            onCopyWalletAddress={(address, key) =>
              void copyWalletAddress(address, key)
            }
            onPasskeySolanaInputChange={setPasskeySolanaInput}
            onSavePasskeySolana={handleSavePasskeySolana}
            onRefreshDestinationWallets={() => void refreshDestinationWallets()}
            transfer={transfer}
          />
        </CardContent>
      </Card>

      {/* ── Info cards ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Route className="h-4 w-4 text-primary" />
              CCTP flow
            </CardTitle>
            <CardDescription>
              The bridge runs through three Circle-controlled stages after your
              personal wallet deposit is approved.
            </CardDescription>
          </CardHeader>
          <div className="px-6 pb-6 space-y-2 text-sm text-muted-foreground/80">
            <p>1. Approve a deposit from your personal source wallet to the treasury wallet.</p>
            <p>2. Burn USDC on the source chain treasury wallet and wait for Circle attestation.</p>
            <p>3. Mint USDC on the destination chain for the wallet you entered.</p>
          </div>
        </Card>

        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-primary" />
              Tracking
            </CardTitle>
            <CardDescription>
              This bridge is non-blocking by design.
            </CardDescription>
          </CardHeader>
          <div className="px-6 pb-6 space-y-2 text-sm text-muted-foreground/80">
            <p>Status refreshes every 4 seconds while a bridge is pending.</p>
            <p>
              The latest transfer is stored locally so the page can resume after
              refresh.
            </p>
            <p>
              If the flow runs longer than 2 minutes, the UI tells the user it
              is still processing on-chain.
            </p>
          </div>
        </Card>
      </div>

      {/* ── Dialogs ── */}
      <BridgeReviewDialog
        open={isReviewDialogOpen}
        onOpenChange={setIsReviewDialogOpen}
        isSubmitting={isSubmitting}
        isExternalEvmBridge={isExternalEvmBridge}
        sourceOption={sourceOption}
        destinationOption={destinationOption}
        amount={amount}
        destinationAddress={destinationAddress}
        transferWalletAddress={transferWallet?.walletAddress}
        externalWalletAddress={externalWalletAddress}
        onSubmit={() => void submitBridge()}
      />

      <BridgeSuccessDialog
        open={isSuccessDialogOpen}
        onOpenChange={setIsSuccessDialogOpen}
        transfer={transfer}
        tokenSymbol={tokenSymbol}
        onStartNew={handleStartNew}
      />
    </div>
  );
}
