"use client";

import type { Address } from "viem";

import { useExternalWallet } from "@/components/providers/external-wallet-context";
import type { WalletMode } from "@/lib/wallet-mode";

interface UseSmartWalletAddressResult {
  smartWalletAddress: Address | undefined;
  embeddedWalletAddress: Address | undefined;
  isLoadingSmartWalletAddress: boolean;
  walletLabel: string;
  walletMode: WalletMode;
}

export function useSmartWalletAddress(): UseSmartWalletAddressResult {
  const { activeWalletAddress, activeWalletLabel, isReady, walletMode } =
    useExternalWallet();
  const isLoadingSmartWalletAddress = !isReady;

  return {
    smartWalletAddress: activeWalletAddress,
    embeddedWalletAddress: undefined,
    isLoadingSmartWalletAddress,
    walletLabel: activeWalletLabel,
    walletMode,
  };
}
