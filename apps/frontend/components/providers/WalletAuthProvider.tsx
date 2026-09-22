"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";
import { useWalletClient } from "wagmi";
import { useExternalWallet } from "@/components/providers/external-wallet-context";
import { backendFetch } from "@/lib/backend-api";
import { activeArcChain } from "@/lib/wagmi";

type StoredSession = {
  address: Address;
  chainId: number;
  expiresAt: string;
  sessionToken: string;
  userId: string;
};

type WalletAuthState = "disconnected" | "wrong_network" | "required" | "authenticating" | "authenticated" | "error";

type WalletAuthContextValue = {
  authenticate: () => Promise<string>;
  error: string | null;
  sessionToken: string | null;
  state: WalletAuthState;
};

const WalletAuthContext = createContext<WalletAuthContextValue | null>(null);
const STORAGE_PREFIX = "wizpay.wallet-auth.v1:";

function storageKey(address: Address) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function readStoredSession(address: Address): StoredSession | null {
  try {
    const value = window.sessionStorage.getItem(storageKey(address));
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredSession;
    if (
      parsed.address.toLowerCase() !== address.toLowerCase() ||
      parsed.chainId !== activeArcChain.id ||
      !parsed.sessionToken ||
      Date.parse(parsed.expiresAt) <= Date.now()
    ) {
      window.sessionStorage.removeItem(storageKey(address));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function WalletAuthProvider({ children }: { children: React.ReactNode }) {
  const { activeWalletAddress, activeWalletChainId } = useExternalWallet();
  const { data: walletClient } = useWalletClient();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionMatches = Boolean(
    session &&
      activeWalletAddress &&
      session.address.toLowerCase() === activeWalletAddress.toLowerCase() &&
      session.chainId === activeWalletChainId &&
      Date.parse(session.expiresAt) > Date.now(),
  );

  useEffect(() => {
    setSession(null);
    setError(null);
    setAuthenticating(false);
    if (!activeWalletAddress || activeWalletChainId !== activeArcChain.id) return;
    setSession(readStoredSession(activeWalletAddress));
  }, [activeWalletAddress, activeWalletChainId]);

  const authenticate = useCallback(async () => {
    if (!activeWalletAddress || !walletClient) throw new Error("Connect an external wallet before authenticating.");
    if (activeWalletChainId !== activeArcChain.id) throw new Error("Switch the external wallet to Arc Mainnet (chain 5042).");
    const existing = readStoredSession(activeWalletAddress);
    if (existing) {
      setSession(existing);
      return existing.sessionToken;
    }
    setAuthenticating(true);
    setError(null);
    try {
      const challenge = await backendFetch<{ challengeId: string; message: string }>("/wallets/auth/challenge", {
        method: "POST",
        body: JSON.stringify({ address: activeWalletAddress, chainId: activeArcChain.id }),
      });
      const signature = await walletClient.signMessage({ account: activeWalletAddress, message: challenge.message });
      const verified = await backendFetch<StoredSession>("/wallets/auth/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
      });
      if (getAddress(verified.address).toLowerCase() !== activeWalletAddress.toLowerCase()) throw new Error("Wallet authentication returned a different address.");
      window.sessionStorage.setItem(storageKey(activeWalletAddress), JSON.stringify(verified));
      setSession(verified);
      return verified.sessionToken;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet authentication failed.");
      throw cause;
    } finally {
      setAuthenticating(false);
    }
  }, [activeWalletAddress, activeWalletChainId, walletClient]);

  const state: WalletAuthState = !activeWalletAddress
    ? "disconnected"
    : activeWalletChainId !== activeArcChain.id
      ? "wrong_network"
      : authenticating
        ? "authenticating"
        : sessionMatches
          ? "authenticated"
          : error
            ? "error"
            : "required";
  const value = useMemo(() => ({ authenticate, error, sessionToken: sessionMatches ? session!.sessionToken : null, state }), [authenticate, error, session, sessionMatches, state]);
  return <WalletAuthContext.Provider value={value}>{children}</WalletAuthContext.Provider>;
}

export function useWalletAuth() {
  const value = useContext(WalletAuthContext);
  if (!value) throw new Error("useWalletAuth must be used within WalletAuthProvider.");
  return value;
}
