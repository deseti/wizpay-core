"use client";

import { createContext, useContext } from "react";
import type { Address } from "viem";

/**
 * External self-custodial wallet context for Arc Mainnet.
 * Identity comes solely from Wagmi/Reown (EOA / Safe user-signed).
 */
export type ExternalWalletContextValue = {
  activeWalletAddress: Address | undefined;
  activeWalletChainId: number | undefined;
  activeWalletChainName: string | null;
  activeWalletLabel: string;
  activeWalletShortAddress: string | null;
  externalConnectError: string | null;
  externalConnectorName: string | null;
  externalWalletAddress: Address | undefined;
  externalWalletChainId: number | undefined;
  externalWalletNativeBalance: string | null;
  isActiveWalletConnected: boolean;
  isExternalConnected: boolean;
  isExternalChainSupported: boolean;
  isReady: boolean;
  requiresArcSwitch: boolean;
  sessionKey: string;
  walletMode: "external";
};

export const ExternalWalletContext =
  createContext<ExternalWalletContextValue | null>(null);

export function useExternalWallet() {
  const context = useContext(ExternalWalletContext);

  if (!context) {
    throw new Error(
      "useExternalWallet must be used within ExternalWalletProvider.",
    );
  }

  return context;
}

/**
 * Backwards-compatible alias for migrated call sites.
 * New code should use useExternalWallet directly.
 */
export const useHybridWallet = useExternalWallet;
export type HybridWalletContextValue = ExternalWalletContextValue;
export const HybridWalletContext = ExternalWalletContext;
