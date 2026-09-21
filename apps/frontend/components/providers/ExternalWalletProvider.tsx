"use client";

import { useEffect, useMemo } from "react";
import type { Address } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
} from "wagmi";

import { formatCompactAddress } from "@/lib/wizpay";
import { getWalletModeLabel } from "@/lib/wallet-mode";
import {
  activeArcChain,
  CHAIN_NAME_BY_ID,
  SUPPORTED_CHAIN_IDS,
} from "@/lib/wagmi";
import {
  ExternalWalletContext,
  type ExternalWalletContextValue,
} from "@/components/providers/external-wallet-context";

/**
 * External-wallet-only provider for Arc Mainnet.
 * Identity comes solely from Wagmi/Reown (EOA / Safe user-signed).
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

  const value = useMemo<ExternalWalletContextValue>(
    () => ({
      activeWalletAddress,
      activeWalletChainId,
      activeWalletChainName,
      activeWalletLabel,
      activeWalletShortAddress,
      externalConnectError: connectError?.message ?? null,
      externalConnectorName: connector?.name ?? null,
      externalWalletAddress: externalAddress as Address | undefined,
      externalWalletChainId: externalChainId,
      externalWalletNativeBalance: externalNativeBalance?.formatted ?? null,
      isActiveWalletConnected: isExternalConnected && Boolean(externalAddress),
      isExternalConnected,
      isExternalChainSupported,
      isReady: true,
      requiresArcSwitch,
      sessionKey,
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
    ],
  );

  return (
    <ExternalWalletContext.Provider value={value}>
      {children}
    </ExternalWalletContext.Provider>
  );
}
