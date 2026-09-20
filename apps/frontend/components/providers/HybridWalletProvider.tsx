"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Address } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
} from "wagmi";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";
import { formatCompactAddress } from "@/lib/wizpay";
import {
  HybridWalletContext,
  useHybridWallet,
  type HybridWalletContextValue,
} from "@/components/providers/hybrid-wallet-context";
import {
  DEFAULT_WALLET_MODE,
  getWalletModeDescription,
  getWalletModeLabel,
  parseWalletMode,
  WALLET_MODE_STORAGE_KEY,
  type WalletMode,
} from "@/lib/wallet-mode";
import {
  arcTestnet,
  CHAIN_NAME_BY_ID,
  ethereumSepolia,
  SUPPORTED_CHAIN_IDS,
} from "@/lib/wagmi";

export type { HybridWalletContextValue };
export { HybridWalletContext, useHybridWallet };

const walletModeListeners = new Set<() => void>();

function notifyWalletModeListeners() {
  walletModeListeners.forEach((listener) => listener());
}

function subscribeWalletMode(listener: () => void) {
  walletModeListeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      walletModeListeners.delete(listener);
    };
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === WALLET_MODE_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener("storage", handleStorage);

  return () => {
    walletModeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function writeWalletMode(mode: WalletMode) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WALLET_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors and continue with in-memory state.
  }

  notifyWalletModeListeners();
}

function readWalletMode() {
  if (typeof window === "undefined") {
    return DEFAULT_WALLET_MODE;
  }

  try {
    return parseWalletMode(
      window.localStorage.getItem(WALLET_MODE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_WALLET_MODE;
  }
}

export function HybridWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    arcWallet,
    authenticated,
    authError: circleAuthError,
    initializationPhase: circleInitializationPhase,
    login: circleLogin,
    primaryWallet,
    ready,
    sepoliaWallet,
  } = useCircleWallet();
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

  const storedWalletMode = useSyncExternalStore(
    subscribeWalletMode,
    readWalletMode,
    () => DEFAULT_WALLET_MODE,
  );
  const walletMode =
    ACTIVE_ARC_NETWORK.key === "arc-mainnet" ? "external" : storedWalletMode;

  const setWalletMode = useCallback((mode: WalletMode) => {
    if (ACTIVE_ARC_NETWORK.key === "arc-mainnet" && mode !== "external") {
      return;
    }
    writeWalletMode(mode);
  }, []);

  const circleWalletAddress = (arcWallet?.address ?? primaryWallet?.address) as
    Address | undefined;
  const circleChainId = arcWallet?.address
    ? arcTestnet.id
    : sepoliaWallet?.address
      ? ethereumSepolia.id
      : undefined;
  const activeWalletAddress =
    walletMode === "circle"
      ? circleWalletAddress
      : (externalAddress as Address | undefined);
  const activeWalletChainId =
    walletMode === "circle" ? circleChainId : externalChainId;
  const activeWalletChainName =
    activeWalletChainId && CHAIN_NAME_BY_ID[activeWalletChainId]
      ? CHAIN_NAME_BY_ID[activeWalletChainId]
      : activeWalletChainId
        ? "Unknown Network"
        : null;
  const activeWalletLabel =
    walletMode === "circle"
      ? getWalletModeLabel("circle")
      : connector?.name
        ? `External Wallet (${connector.name})`
        : getWalletModeLabel("external");
  const activeWalletModeDescription = getWalletModeDescription(walletMode);
  const activeWalletShortAddress = activeWalletAddress
    ? formatCompactAddress(activeWalletAddress)
    : null;
  const circleConnected = authenticated && Boolean(circleWalletAddress);
  const activeWalletConnected =
    walletMode === "circle"
      ? circleConnected
      : isExternalConnected && Boolean(externalAddress);
  const isExternalChainSupported =
    !externalChainId || SUPPORTED_CHAIN_IDS.has(externalChainId);
  const requiresArcSwitch =
    walletMode === "external" &&
    isExternalConnected &&
    externalChainId !== arcTestnet.id;
  const isReady = walletMode === "external" || ready;
  const sessionKey = `${walletMode}:${activeWalletAddress ?? "disconnected"}:${activeWalletChainId ?? "none"}`;

  useEffect(() => {
    if (walletMode === "circle") {
      return;
    }

    if (!isExternalConnected && connectors.length === 0) {
      disconnect();
    }
  }, [connectors.length, disconnect, isExternalConnected, walletMode]);

  const value = useMemo<HybridWalletContextValue>(
    () => ({
      activeWalletAddress,
      activeWalletChainId,
      activeWalletChainName,
      activeWalletLabel,
      activeWalletModeDescription,
      activeWalletShortAddress,
      circleAuthError,
      circleInitializationPhase,
      circleLogin,
      circleReady: ready,
      circleWalletAddress,
      externalConnectError: connectError?.message ?? null,
      externalConnectorName: connector?.name ?? null,
      externalWalletAddress: externalAddress as Address | undefined,
      externalWalletChainId: externalChainId,
      externalWalletNativeBalance: externalNativeBalance?.formatted ?? null,
      isActiveWalletConnected: activeWalletConnected,
      isCircleConnected: circleConnected,
      isExternalConnected,
      isExternalChainSupported,
      isReady,
      requiresArcSwitch,
      sessionKey,
      setWalletMode,
      walletMode,
    }),
    [
      activeWalletAddress,
      activeWalletChainId,
      activeWalletChainName,
      activeWalletConnected,
      activeWalletLabel,
      activeWalletModeDescription,
      activeWalletShortAddress,
      circleAuthError,
      circleConnected,
      circleInitializationPhase,
      circleLogin,
      circleWalletAddress,
      connectError?.message,
      connector?.name,
      externalAddress,
      externalChainId,
      externalNativeBalance?.formatted,
      isExternalChainSupported,
      isExternalConnected,
      isReady,
      ready,
      requiresArcSwitch,
      sessionKey,
      setWalletMode,
      walletMode,
    ],
  );

  return (
    <HybridWalletContext.Provider value={value}>
      {children}
    </HybridWalletContext.Provider>
  );
}
