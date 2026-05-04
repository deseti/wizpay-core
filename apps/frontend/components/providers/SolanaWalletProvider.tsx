"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  SendOptions,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

export type SolanaPublicKeyLike = {
  toString(): string;
  toBase58?: () => string;
};

type SolanaConnectResult = {
  publicKey: SolanaPublicKeyLike;
};

export type InjectedSolanaWalletProvider = {
  isConnected: boolean;
  publicKey?: SolanaPublicKeyLike;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<SolanaConnectResult>;
  disconnect: () => Promise<void>;
  on?: (
    event: "connect" | "disconnect" | "accountChanged",
    handler: (publicKey?: SolanaPublicKeyLike | null) => void
  ) => void;
  off?: (
    event: "connect" | "disconnect" | "accountChanged",
    handler: (publicKey?: SolanaPublicKeyLike | null) => void
  ) => void;
  signAndSendTransaction?: (
    transaction: Transaction | VersionedTransaction,
    options?: SendOptions
  ) => Promise<{ signature: string }>;
  signTransaction: (
    transaction: Transaction | VersionedTransaction
  ) => Promise<Transaction | VersionedTransaction>;
  signAllTransactions?: (
    transactions: Array<Transaction | VersionedTransaction>
  ) => Promise<Array<Transaction | VersionedTransaction>>;
  signMessage?: (message: Uint8Array) => Promise<{ signature: Uint8Array }>;
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  isGlow?: boolean;
  isCoin98?: boolean;
  isExodus?: boolean;
  isNuFi?: boolean;
  name?: string;
};

export interface SolanaWalletDescriptor {
  id: string;
  label: string;
  provider: InjectedSolanaWalletProvider;
}

type SolanaWindow = Window & {
  phantom?: { solana?: InjectedSolanaWalletProvider };
  solana?: InjectedSolanaWalletProvider;
  solflare?: InjectedSolanaWalletProvider;
  backpack?:
    | InjectedSolanaWalletProvider
    | { solana?: InjectedSolanaWalletProvider };
  xnft?: { solana?: InjectedSolanaWalletProvider };
  glowSolana?: InjectedSolanaWalletProvider;
  coin98?: { sol?: InjectedSolanaWalletProvider };
  exodus?: { solana?: InjectedSolanaWalletProvider };
  nufi?: { solana?: InjectedSolanaWalletProvider };
};

type SolanaWalletContextValue = {
  availableWallets: ReadonlyArray<SolanaWalletDescriptor>;
  selectedWalletId: string | null;
  selectedWalletLabel: string | null;
  selectWallet: (walletId: string) => void;
  connect: (walletId?: string) => Promise<string>;
  disconnect: () => Promise<void>;
  errorMessage: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  isInstalled: boolean;
  provider: InjectedSolanaWalletProvider | null;
  publicKey: SolanaPublicKeyLike | null;
  publicKeyBase58: string | null;
  refreshWallets: () => void;
};

const SolanaWalletContext = createContext<SolanaWalletContextValue | null>(
  null
);

function isSolanaWalletProvider(
  value: unknown
): value is InjectedSolanaWalletProvider {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    typeof (value as InjectedSolanaWalletProvider).connect === "function" &&
    typeof (value as InjectedSolanaWalletProvider).disconnect === "function" &&
    typeof (value as InjectedSolanaWalletProvider).signTransaction === "function"
  );
}

function toWalletAddress(publicKey: SolanaPublicKeyLike | null | undefined) {
  if (!publicKey) {
    return null;
  }

  if (typeof publicKey.toBase58 === "function") {
    return publicKey.toBase58();
  }

  return publicKey.toString();
}

function inferSolanaWalletLabel(
  provider: InjectedSolanaWalletProvider,
  fallbackLabel: string
) {
  if (provider.name?.trim()) {
    return provider.name.trim();
  }

  if (provider.isPhantom) {
    return "Phantom";
  }

  if (provider.isSolflare) {
    return "Solflare";
  }

  if (provider.isBackpack) {
    return "Backpack";
  }

  if (provider.isGlow) {
    return "Glow";
  }

  if (provider.isCoin98) {
    return "Coin98";
  }

  if (provider.isExodus) {
    return "Exodus";
  }

  if (provider.isNuFi) {
    return "NuFi";
  }

  return fallbackLabel;
}

function collectInjectedSolanaWallets() {
  if (typeof window === "undefined") {
    return [] as SolanaWalletDescriptor[];
  }

  const solanaWindow = window as SolanaWindow;
  const wallets: SolanaWalletDescriptor[] = [];
  const seenProviders: InjectedSolanaWalletProvider[] = [];

  const pushWallet = (
    walletId: string,
    fallbackLabel: string,
    provider: unknown
  ) => {
    if (!isSolanaWalletProvider(provider)) {
      return;
    }

    if (seenProviders.includes(provider)) {
      return;
    }

    seenProviders.push(provider);
    wallets.push({
      id: walletId,
      label: inferSolanaWalletLabel(provider, fallbackLabel),
      provider,
    });
  };

  pushWallet("phantom", "Phantom", solanaWindow.phantom?.solana);
  pushWallet("solflare", "Solflare", solanaWindow.solflare);
  pushWallet(
    "backpack",
    "Backpack",
    solanaWindow.backpack && "solana" in solanaWindow.backpack
      ? solanaWindow.backpack.solana
      : solanaWindow.backpack
  );
  pushWallet("xnft", "Backpack", solanaWindow.xnft?.solana);
  pushWallet("glow", "Glow", solanaWindow.glowSolana);
  pushWallet("coin98", "Coin98", solanaWindow.coin98?.sol);
  pushWallet("exodus", "Exodus", solanaWindow.exodus?.solana);
  pushWallet("nufi", "NuFi", solanaWindow.nufi?.solana);
  pushWallet("injected", "Solana wallet", solanaWindow.solana);

  return wallets;
}

function normalizeSolanaWalletError(error: unknown, walletLabel?: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (walletLabel) {
    return `Unable to connect to ${walletLabel}.`;
  }

  return "Unable to connect to a Solana wallet.";
}

export function SolanaWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [availableWallets, setAvailableWallets] = useState<
    ReadonlyArray<SolanaWalletDescriptor>
  >([]);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<SolanaPublicKeyLike | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshWallets = useCallback(() => {
    const nextWallets = collectInjectedSolanaWallets();

    setAvailableWallets(nextWallets);
    setSelectedWalletId((previousWalletId) => {
      if (
        previousWalletId &&
        nextWallets.some((wallet) => wallet.id === previousWalletId)
      ) {
        return previousWalletId;
      }

      return (
        nextWallets.find((wallet) => wallet.provider.isConnected)?.id ??
        nextWallets[0]?.id ??
        null
      );
    });
  }, []);

  useEffect(() => {
    refreshWallets();

    if (typeof window === "undefined") {
      return;
    }

    window.addEventListener("focus", refreshWallets);
    return () => {
      window.removeEventListener("focus", refreshWallets);
    };
  }, [refreshWallets]);

  const selectedWallet = useMemo(
    () =>
      availableWallets.find((wallet) => wallet.id === selectedWalletId) ??
      availableWallets.find((wallet) => wallet.provider.isConnected) ??
      availableWallets[0] ??
      null,
    [availableWallets, selectedWalletId]
  );

  const provider = selectedWallet?.provider ?? null;

  useEffect(() => {
    setPublicKey(provider?.publicKey ?? null);

    if (!provider?.on || !provider.off) {
      return;
    }

    const handleConnect = (nextPublicKey?: SolanaPublicKeyLike | null) => {
      setPublicKey(nextPublicKey ?? provider.publicKey ?? null);
      setErrorMessage(null);
      setIsConnecting(false);
      refreshWallets();
    };

    const handleDisconnect = () => {
      setPublicKey(null);
      setIsConnecting(false);
      refreshWallets();
    };

    const handleAccountChanged = (nextPublicKey?: SolanaPublicKeyLike | null) => {
      setPublicKey(nextPublicKey ?? null);
    };

    provider.on("connect", handleConnect);
    provider.on("disconnect", handleDisconnect);
    provider.on("accountChanged", handleAccountChanged);

    return () => {
      provider.off?.("connect", handleConnect);
      provider.off?.("disconnect", handleDisconnect);
      provider.off?.("accountChanged", handleAccountChanged);
    };
  }, [provider, refreshWallets]);

  const selectWallet = useCallback(
    (walletId: string) => {
      setSelectedWalletId(walletId);
      setErrorMessage(null);
      setPublicKey(
        availableWallets.find((wallet) => wallet.id === walletId)?.provider
          .publicKey ?? null
      );
    },
    [availableWallets]
  );

  const connect = useCallback(
    async (walletId?: string) => {
      const targetWallet =
        (walletId
          ? availableWallets.find((wallet) => wallet.id === walletId)
          : selectedWallet) ?? availableWallets[0];

      if (!targetWallet) {
        const message =
          "No compatible Solana wallet extension is installed. Install Phantom, Solflare, Backpack, or another Solana wallet and try again.";
        setErrorMessage(message);
        throw new Error(message);
      }

      setSelectedWalletId(targetWallet.id);
      setIsConnecting(true);
      setErrorMessage(null);

      try {
        const result = await targetWallet.provider.connect();
        const nextPublicKey =
          result.publicKey ?? targetWallet.provider.publicKey ?? null;
        const nextAddress = toWalletAddress(nextPublicKey);

        if (!nextPublicKey || !nextAddress) {
          throw new Error(
            `${targetWallet.label} did not return a Solana wallet address.`
          );
        }

        setPublicKey(nextPublicKey);
        refreshWallets();
        return nextAddress;
      } catch (error) {
        const message = normalizeSolanaWalletError(error, targetWallet.label);
        setErrorMessage(message);
        throw new Error(message);
      } finally {
        setIsConnecting(false);
      }
    },
    [availableWallets, refreshWallets, selectedWallet]
  );

  const disconnect = useCallback(async () => {
    if (!provider) {
      setPublicKey(null);
      return;
    }

    try {
      await provider.disconnect();
    } finally {
      setPublicKey(null);
      refreshWallets();
    }
  }, [provider, refreshWallets]);

  const value = useMemo<SolanaWalletContextValue>(
    () => ({
      availableWallets,
      selectedWalletId,
      selectedWalletLabel: selectedWallet?.label ?? null,
      selectWallet,
      connect,
      disconnect,
      errorMessage,
      isConnected: Boolean(publicKey),
      isConnecting,
      isInstalled: availableWallets.length > 0,
      provider,
      publicKey,
      publicKeyBase58: toWalletAddress(publicKey),
      refreshWallets,
    }),
    [
      availableWallets,
      connect,
      disconnect,
      errorMessage,
      isConnecting,
      provider,
      publicKey,
      refreshWallets,
      selectWallet,
      selectedWallet,
      selectedWalletId,
    ]
  );

  return (
    <SolanaWalletContext.Provider value={value}>
      {children}
    </SolanaWalletContext.Provider>
  );
}

export function useSolanaWallet() {
  const context = useContext(SolanaWalletContext);

  if (!context) {
    throw new Error(
      "useSolanaWallet must be used within SolanaWalletProvider."
    );
  }

  return context;
}