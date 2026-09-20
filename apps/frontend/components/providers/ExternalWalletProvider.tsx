"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { Address } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
} from "wagmi";

import { formatCompactAddress } from "@/lib/wizpay";
import {
  getWalletModeDescription,
  getWalletModeLabel,
} from "@/lib/wallet-mode";
import {
  activeArcChain,
  CHAIN_NAME_BY_ID,
  SUPPORTED_CHAIN_IDS,
} from "@/lib/wagmi";
import {
  HybridWalletContext,
  type HybridWalletContextValue,
} from "@/components/providers/hybrid-wallet-context";

/**
 * External-wallet-only provider for Arc Mainnet.
 *
 * The active wallet comes solely from Wagmi/Reown (user signs every
 * transaction). No Circle SDK, auth state, login UI, or fallback exists on
 * this path: Circle fields are inert constants, walletMode is always
 * "external", and a disconnected external wallet stays disconnected.
 * Arc Testnet continues to use HybridWalletProvider (Circle + external).
 */
export function ExternalWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    address: externalAddress,
    connector,
    isConnected: isExternalConnected,
  } = useAccount();
  const { connectors, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const externalChainId = useChainId();
  const { data: externalNativeBalance } = useBalance({
    address: externalAddress,
    chainId: externalChainId,
    query: {
      enabled: Boolean(externalAddress && externalChainId),
      staleTime: 15_000,
    },
  });

  const setWalletMode = useCallback(() => {
    // Mainnet is external-wallet-only; mode selection is a no-op so a Circle
    // mode can never activate here.
  }, []);

  const activeWalletAddress = externalAddress as Address | undefined;
  const activeWalletChainId = externalChainId;
  const activeWalletChainName =
    activeWalletChainId && CHAIN_NAME_BY_ID[activeWalletChainId]
      ? CHAIN_NAME_BY_ID[activeWalletChainId]
      : activeWalletChainId
        ? "Unknown Network"
        : null;
  const activeWalletLabel = connector?.name
    ? `External Wallet (${connector.name})`
    : getWalletModeLabel("external");
  const activeWalletShortAddress = activeWalletAddress
    ? formatCompactAddress(activeWalletAddress)
    : null;
  const isExternalChainSupported =
    !externalChainId || SUPPORTED_CHAIN_IDS.has(externalChainId);
  const requiresArcSwitch =
    isExternalConnected && externalChainId !== activeArcChain.id;
  const sessionKey = `external:${activeWalletAddress ?? "disconnected"}:${activeWalletChainId ?? "none"}`;

  useEffect(() => {
    if (!isExternalConnected && connectors.length === 0) {
      disconnect();
    }
  }, [connectors.length, disconnect, isExternalConnected]);

  const value = useMemo<HybridWalletContextValue>(
    () => ({
      activeWalletAddress,
      activeWalletChainId,
      activeWalletChainName,
      activeWalletLabel,
      activeWalletModeDescription: getWalletModeDescription("external"),
      activeWalletShortAddress,
      circleAuthError: null,
      circleInitializationPhase: "recoverable_error",
      circleLogin: () => {},
      circleReady: false,
      circleWalletAddress: undefined,
      externalConnectError: connectError?.message ?? null,
      externalConnectorName: connector?.name ?? null,
      externalWalletAddress: externalAddress as Address | undefined,
      externalWalletChainId: externalChainId,
      externalWalletNativeBalance: externalNativeBalance?.formatted ?? null,
      isActiveWalletConnected: isExternalConnected && Boolean(externalAddress),
      isCircleConnected: false,
      isExternalConnected,
      isExternalChainSupported,
      isReady: true,
      requiresArcSwitch,
      sessionKey,
      setWalletMode,
      walletMode: "external",
    }),
    [
      activeWalletAddress,
      activeWalletChainId,
      activeWalletChainName,
      activeWalletLabel,
      activeWalletShortAddress,
      connectError?.message,
      connector?.name,
      externalAddress,
      externalChainId,
      externalNativeBalance?.formatted,
      isExternalChainSupported,
      isExternalConnected,
      requiresArcSwitch,
      sessionKey,
      setWalletMode,
    ],
  );

  return (
    <HybridWalletContext.Provider value={value}>
      {children}
    </HybridWalletContext.Provider>
  );
}
