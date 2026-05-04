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
    isExternalCrossChainBridge,
    externalBridgeRouteKind,
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
    externalSolanaWalletAddress,
    availableSolanaWallets,
    selectedSolanaWalletId,
    selectedSolanaWalletLabel,
    requiredExternalWalletLabels,
    hasRequiredExternalWallets,
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
    selectSolanaWallet,
    connectSolanaWallet,
    openBridgeReview,
    submitBridge,
    retryAttestation,
    handleStartNew,
  } = useBridgeScreen();

  const requiresSolanaWallet = requiredExternalWalletLabels.includes("Solana wallet");
  const requiresEvmWallet = requiredExternalWalletLabels.includes("EVM wallet");
  const isSolanaSourceExternalRoute =
    isExternalBridgeMode && sourceChain === "SOLANA-DEVNET";
  const solanaWalletDisplayName =
    selectedSolanaWalletLabel ?? "Solana wallet";
  const bridgeIntro = isExternalBridgeMode
    ? "Circle CCTP V2 bridge with wallet-controlled signing. WizPay keeps browser-wallet routes on the client so the required wallets confirm burn and mint directly across Arc, Sepolia, and Solana Devnet."
    : "Circle CCTP bridge across Arc, Sepolia, and Solana Devnet. App Wallet mode funds the source treasury first, then WizPay executes the bridge from the treasury wallet."
  const executionModelDescription = isExternalBridgeMode
    ? isExternalCrossChainBridge
      ? `External route: ${requiredExternalWalletLabels.join(" + ")} stay in control. The source wallet signs the burn, Circle attests it, and the destination wallet signs the mint.`
      : "External route: your EVM wallet signs approve, burn, and destination mint directly. No treasury wallet is involved."
    : "App Wallet route: WizPay first requests a deposit from your personal Circle wallet into the source treasury wallet, then the treasury wallet completes the bridge."
  const routeSummary = isExternalBridgeMode
    ? isExternalCrossChainBridge
      ? `Route: burn from your ${sourceOption.label} source wallet, wait for Circle attestation, then mint on ${destinationOption.label} with the destination wallet.`
      : `Route: approve and burn on ${sourceOption.label}, wait for Circle attestation, then mint on ${destinationOption.label} from your EVM wallet.`
    : `Route: approve a deposit from your personal ${sourceOption.label} wallet into the source treasury wallet, then burn from treasury and mint to your destination address on ${destinationOption.label}.`;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-up space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Bridge
          </h1>
          <p className="text-sm text-muted-foreground/70">
            {bridgeIntro}
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
            {isExternalBridgeMode
              ? "Choose source and destination networks, then let the required external wallets sign the CCTP flow directly in the browser."
              : "Choose source and destination networks. WizPay will request a Circle wallet approval to move funds into the source treasury before the treasury wallet completes the bridge."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 py-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          {/* ── Left column ── */}
          <div className="space-y-5">
            {/* Treasury model banner */}
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary/80">
                Execution model
              </p>
              <p className="mt-2 text-sm text-muted-foreground/80">
                {executionModelDescription}
              </p>
            </div>

            {/* Mode-specific banners */}
            {isExternalBridgeMode ? (
              <div className="space-y-3">
                <div className="rounded-2xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-primary/90">
                  {isExternalCrossChainBridge
                    ? `External cross-chain mode is active. Keep ${requiredExternalWalletLabels.join(" and ")} available until the burn and destination mint are both confirmed.`
                    : "External EVM mode is active. Your connected wallet will sign approve, burn, and destination mint directly."}
                </div>
                {externalBridgeModeMessage ? (
                  <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                    {externalBridgeModeMessage}
                  </div>
                ) : null}
                {(requiresEvmWallet || externalWalletAddress) ? (
                  <div className="rounded-2xl border border-border/40 bg-background/40 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground/70">
                        EVM wallet
                      </span>
                      <span className="font-mono text-xs">
                        {externalWalletAddress
                          ? shortenAddress(externalWalletAddress)
                          : "Not connected"}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-muted-foreground/70">
                        Source balance check
                      </span>
                      <span
                        className={`font-mono text-xs ${!hasEnoughExternalUsdc && !isSolanaSourceExternalRoute ? "text-destructive" : ""}`}
                      >
                        {externalUsdcBalanceLabel}
                      </span>
                    </div>
                    {externalWalletChainId &&
                    externalWalletChainId !== sourceChainId &&
                    !isSolanaSourceExternalRoute ? (
                      <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                        Wallet is on a different chain. WizPay will request a
                        chain switch before the source-side confirmation.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {requiresSolanaWallet ? (
                  <div className="rounded-2xl border border-border/40 bg-background/40 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground/70">
                        {solanaWalletDisplayName}
                      </span>
                      <span className="font-mono text-xs">
                        {externalSolanaWalletAddress
                          ? shortenAddress(externalSolanaWalletAddress)
                          : "Not connected"}
                      </span>
                    </div>
                    {availableSolanaWallets.length > 1 ? (
                      <div className="mt-3 space-y-2">
                        <label className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                          Wallet provider
                        </label>
                        <Select
                          value={selectedSolanaWalletId ?? ""}
                          onValueChange={selectSolanaWallet}
                          disabled={isSubmitting}
                        >
                          <SelectTrigger className="h-9 border-border/40 bg-background/60 text-xs">
                            <SelectValue placeholder="Choose a Solana wallet" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableSolanaWallets.map((wallet) => (
                              <SelectItem key={wallet.id} value={wallet.id}>
                                {wallet.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                    <p className="mt-2 text-xs text-muted-foreground/70">
                      Solana burn and mint confirmations are signed in your connected Solana wallet.
                    </p>
                    {!externalSolanaWalletAddress ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        onClick={() => void connectSolanaWallet()}
                        disabled={isSubmitting}
                      >
                        {availableSolanaWallets.length > 0
                          ? `Connect ${solanaWalletDisplayName}`
                          : "Connect Solana wallet"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {isPositiveDecimal(amount) && !hasEnoughExternalUsdc && !isSolanaSourceExternalRoute ? (
                  <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    Insufficient USDC: wallet holds {externalUsdcBalanceLabel}{" "}
                    on {sourceOption.label}, but {amount} USDC is needed. Fund
                    the wallet before bridging.
                  </div>
                ) : null}
              </div>
            ) : isPasskeyUnsupportedSource ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                {passkeySourceRestrictionMessage}
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
              {routeSummary}
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

            {!isExternalBridgeMode &&
            transferWallet &&
            treasuryWalletEmpty &&
            !isPositiveDecimal(amount) ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                Bridge requires USDC in the selected {sourceOption.label} source
                treasury wallet. If your funded wallet is on the other network,
                switch the source network above before bridging.
              </div>
            ) : null}

            {!isExternalBridgeMode &&
            transferWallet &&
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
                {isExternalBridgeMode
                  ? isExternalCrossChainBridge
                    ? "WizPay keeps the transaction orchestration in the browser. The source wallet confirms the burn, Circle attests it, then the destination wallet confirms the mint."
                    : "WizPay keeps the transaction orchestration in the browser. Your EVM wallet confirms each CCTP step directly."
                  : "A Circle wallet popup appears before the bridge starts so you can approve the deposit from your personal source wallet into the selected source treasury wallet. After that confirmation, the backend treasury wallet executes the bridge."}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button
                  onClick={openBridgeReview}
                  disabled={
                    isSubmitting ||
                    (!isExternalBridgeMode &&
                      (isWalletLoading || isWalletBootstrapping)) ||
                    (isExternalBridgeMode &&
                      (!hasRequiredExternalWallets || !hasEnoughExternalUsdc))
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
                ) : isExternalBridgeMode && !hasRequiredExternalWallets ? (
                  <p className="text-sm text-muted-foreground/70">
                    Connect {requiredExternalWalletLabels.join(" and ")} to
                    start this external bridge route.
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
              {isExternalBridgeMode
                ? "External wallet routes still follow the standard CCTP lifecycle, but the source and destination wallets sign the on-chain steps directly."
                : "App Wallet mode runs through three stages after your personal wallet deposit is approved."}
            </CardDescription>
          </CardHeader>
          <div className="px-6 pb-6 space-y-2 text-sm text-muted-foreground/80">
            {isExternalBridgeMode ? (
              <>
                <p>1. Confirm the source-side burn path in the required external wallet.</p>
                <p>2. Wait for Circle attestation to become available for the burn.</p>
                <p>3. Confirm the destination-side mint in the receiving wallet.</p>
              </>
            ) : (
              <>
                <p>1. Approve a deposit from your personal source wallet to the treasury wallet.</p>
                <p>2. Burn USDC on the source chain treasury wallet and wait for Circle attestation.</p>
                <p>3. Mint USDC on the destination chain for the wallet you entered.</p>
              </>
            )}
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
        isExternalBridgeMode={isExternalBridgeMode}
        isExternalEvmBridge={isExternalEvmBridge}
        externalBridgeRouteKind={externalBridgeRouteKind}
        sourceOption={sourceOption}
        destinationOption={destinationOption}
        amount={amount}
        destinationAddress={destinationAddress}
        transferWalletAddress={transferWallet?.walletAddress}
        externalWalletAddress={externalWalletAddress}
        solanaWalletAddress={externalSolanaWalletAddress}
        solanaWalletLabel={solanaWalletDisplayName}
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
