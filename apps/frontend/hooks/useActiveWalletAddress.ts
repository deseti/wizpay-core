"use client";

import type { Address } from "viem";
import type { WalletMode } from "@/lib/wallet-mode";

import { useExternalWallet } from "@/components/providers/external-wallet-context";

type ActiveWalletAddressResult = {
  isConnected: boolean;
  walletMode: WalletMode;
  walletAddress: Address | undefined;
};

export function useActiveWalletAddress(): ActiveWalletAddressResult {
  const { activeWalletAddress, isActiveWalletConnected, walletMode } =
    useExternalWallet();

  return {
    isConnected: isActiveWalletConnected,
    walletAddress: activeWalletAddress,
    walletMode,
  };
}
