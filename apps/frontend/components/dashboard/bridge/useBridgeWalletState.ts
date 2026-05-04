"use client";

import { useCallback, useEffect, useState } from "react";

import {
  bootstrapCircleTransferWallet,
  getCircleTransferWallet,
  TransferApiError,
  type CircleTransferBlockchain,
  type CircleTransferWallet,
} from "@/lib/transfer-service";

import {
  DESTINATION_OPTIONS,
  USDC_ADDRESS_BY_CHAIN,
  type DestinationWalletMap,
} from "./bridge-types";
import {
  clearStoredTransferWallet,
  getStoredTransferWallet,
  setStoredTransferWallet,
} from "./bridge-storage";
import { getBridgeErrorMessage, shortenAddress } from "./bridge-utils";

interface ToastArgs {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

interface UseBridgeWalletStateParams {
  sourceChain: CircleTransferBlockchain;
  sourceTokenAddress: string | undefined;
  sourceLabel: string;
  destinationLabel: string;
  tokenSymbol: string;
  toast: (args: ToastArgs) => void;
}

export function useBridgeWalletState({
  sourceChain,
  sourceTokenAddress,
  sourceLabel,
  destinationLabel,
  tokenSymbol,
  toast,
}: UseBridgeWalletStateParams) {
  const [transferWallet, setTransferWallet] =
    useState<CircleTransferWallet | null>(null);
  const [walletStatusError, setWalletStatusError] = useState<string | null>(
    null
  );
  const [isWalletLoading, setIsWalletLoading] = useState(false);
  const [isWalletBootstrapping, setIsWalletBootstrapping] = useState(false);
  const [destinationWallets, setDestinationWallets] =
    useState<DestinationWalletMap>({});
  const [isDestinationWalletsLoading, setIsDestinationWalletsLoading] =
    useState(false);
  const [copiedWallet, setCopiedWallet] = useState<string | null>(null);

  const buildWalletErrorMessage = useCallback(
    (error: unknown) =>
      getBridgeErrorMessage(error, {
        destinationLabel,
        sourceLabel,
      }),
    [destinationLabel, sourceLabel]
  );

  const refreshTransferWallet = useCallback(async () => {
    setIsWalletLoading(true);
    setTransferWallet((current) =>
      current?.blockchain === sourceChain ? current : null
    );
    const stored = getStoredTransferWallet(sourceChain);
    try {
      const wallet = await getCircleTransferWallet({
        blockchain: sourceChain,
        tokenAddress: sourceTokenAddress,
        walletId: stored?.walletId || undefined,
        walletAddress: stored?.walletAddress || undefined,
      });
      setTransferWallet(wallet);
      setStoredTransferWallet(sourceChain, wallet);
      setWalletStatusError(null);
    } catch (error) {
      if (
        error instanceof TransferApiError &&
        (error.code === "CIRCLE_WALLET_NOT_FOUND" ||
          error.code === "CIRCLE_WALLET_CONFIG_MISSING" ||
          error.code === "CIRCLE_WALLET_CHAIN_MISMATCH" ||
          error.code === "CIRCLE_WALLET_ID_MISMATCH")
      ) {
        clearStoredTransferWallet(sourceChain);
      }
      setTransferWallet(null);
      setWalletStatusError(buildWalletErrorMessage(error));
    } finally {
      setIsWalletLoading(false);
    }
  }, [buildWalletErrorMessage, sourceChain, sourceTokenAddress]);

  useEffect(() => {
    let cancelled = false;

    async function loadTransferWallet() {
      setIsWalletLoading(true);
      setTransferWallet((current) =>
        current?.blockchain === sourceChain ? current : null
      );

      const stored = getStoredTransferWallet(sourceChain);

      try {
        const wallet = await getCircleTransferWallet({
          blockchain: sourceChain,
          tokenAddress: sourceTokenAddress,
          walletId: stored?.walletId || undefined,
          walletAddress: stored?.walletAddress || undefined,
        });

        if (cancelled) return;
        setTransferWallet(wallet);
        setStoredTransferWallet(sourceChain, wallet);
        setWalletStatusError(null);
      } catch (error) {
        if (cancelled) return;
        if (
          error instanceof TransferApiError &&
          (error.code === "CIRCLE_WALLET_NOT_FOUND" ||
            error.code === "CIRCLE_WALLET_CONFIG_MISSING" ||
            error.code === "CIRCLE_WALLET_CHAIN_MISMATCH" ||
            error.code === "CIRCLE_WALLET_ID_MISMATCH")
        ) {
          clearStoredTransferWallet(sourceChain);
        }
        setTransferWallet(null);
        setWalletStatusError(buildWalletErrorMessage(error));
      } finally {
        if (!cancelled) setIsWalletLoading(false);
      }
    }

    void loadTransferWallet();
    return () => {
      cancelled = true;
    };
  }, [buildWalletErrorMessage, sourceChain, sourceTokenAddress]);

  const refreshDestinationWallets = useCallback(async () => {
    setIsDestinationWalletsLoading(true);
    const chains = DESTINATION_OPTIONS.map((opt) => opt.id);
    try {
      const entries = await Promise.all(
        chains.map(async (chain) => {
          const tokenAddress = USDC_ADDRESS_BY_CHAIN[chain];
          if (!tokenAddress) return [chain, null] as const;
          const stored = getStoredTransferWallet(chain);
          try {
            const wallet = await getCircleTransferWallet({
              blockchain: chain,
              tokenAddress,
              walletId: stored?.walletId || undefined,
              walletAddress: stored?.walletAddress || undefined,
            });
            setStoredTransferWallet(chain, wallet);
            return [chain, wallet] as const;
          } catch {
            return [chain, null] as const;
          }
        })
      );
      const next: DestinationWalletMap = {};
      for (const [chain, wallet] of entries) {
        next[chain] = wallet;
      }
      setDestinationWallets(next);
    } finally {
      setIsDestinationWalletsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Destination wallet discovery intentionally runs once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshDestinationWallets();
  }, [refreshDestinationWallets]);

  const copyWalletAddress = useCallback(async (address: string, key: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedWallet(key);
      window.setTimeout(() => setCopiedWallet(null), 2000);
    } catch {
      // clipboard not available
    }
  }, []);

  const handleBootstrapWallet = useCallback(async () => {
    setIsWalletBootstrapping(true);
    setWalletStatusError(null);
    try {
      const wallet = await bootstrapCircleTransferWallet({
        blockchain: sourceChain,
        tokenAddress: sourceTokenAddress,
        refId: `WIZPAY-BRIDGE-SOURCE-${sourceChain}-${Date.now()}`,
        walletName: `WizPay ${sourceLabel} App Treasury Wallet`,
      });
      setTransferWallet(wallet);
      setStoredTransferWallet(sourceChain, wallet);
      void refreshDestinationWallets();
      setWalletStatusError(null);
      toast({
        title: "App treasury wallet ready",
        description: `Fund ${shortenAddress(wallet.walletAddress)} on ${sourceLabel} with ${tokenSymbol} before bridging.`,
      });
    } catch (error) {
      const message = buildWalletErrorMessage(error);
      setWalletStatusError(message);
      toast({
        title: "Source wallet setup failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsWalletBootstrapping(false);
    }
  }, [
    buildWalletErrorMessage,
    refreshDestinationWallets,
    sourceChain,
    sourceLabel,
    sourceTokenAddress,
    toast,
    tokenSymbol,
  ]);

  return {
    transferWallet,
    walletStatusError,
    isWalletLoading,
    isWalletBootstrapping,
    destinationWallets,
    isDestinationWalletsLoading,
    copiedWallet,
    refreshTransferWallet,
    refreshDestinationWallets,
    copyWalletAddress,
    handleBootstrapWallet,
  };
}