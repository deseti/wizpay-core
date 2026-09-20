"use client";

import { createContext, useContext } from "react";
import type { Address } from "viem";
import type { CircleInitializationPhase } from "@/lib/circle-runtime";
import type { WalletMode } from "@/lib/wallet-mode";

/**
 * Consumer-facing wallet context shared by both network boundaries:
 * - Arc Testnet mounts HybridWalletProvider (Circle + external).
 * - Arc Mainnet mounts ExternalWalletProvider (Wagmi/Reown only).
 *
 * Circle login fields are exposed through this context so Mainnet-visible
 * components (e.g. ConnectWalletCard) never need Circle auth state to render
 * the external-wallet path. On Mainnet they are inert constants and the
 * Circle branch is unreachable because walletMode is always "external".
 */
export type HybridWalletContextValue = {
  activeWalletAddress: Address | undefined;
  activeWalletChainId: number | undefined;
  activeWalletChainName: string | null;
  activeWalletLabel: string;
  activeWalletModeDescription: string;
  activeWalletShortAddress: string | null;
  circleAuthError: string | null;
  circleInitializationPhase: CircleInitializationPhase;
  circleLogin: () => void;
  circleReady: boolean;
  circleWalletAddress: Address | undefined;
  externalConnectError: string | null;
  externalConnectorName: string | null;
  externalWalletAddress: Address | undefined;
  externalWalletChainId: number | undefined;
  externalWalletNativeBalance: string | null;
  isActiveWalletConnected: boolean;
  isCircleConnected: boolean;
  isExternalConnected: boolean;
  isExternalChainSupported: boolean;
  isReady: boolean;
  requiresArcSwitch: boolean;
  sessionKey: string;
  setWalletMode: (mode: WalletMode) => void;
  walletMode: WalletMode;
};

export const HybridWalletContext =
  createContext<HybridWalletContextValue | null>(null);

export function useHybridWallet() {
  const context = useContext(HybridWalletContext);

  if (!context) {
    throw new Error(
      "useHybridWallet must be used within HybridWalletProvider or ExternalWalletProvider.",
    );
  }

  return context;
}
