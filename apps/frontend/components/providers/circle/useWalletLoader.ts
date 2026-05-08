"use client";

import { useCallback, useRef } from "react";
import type React from "react";
import type { WebAuthnCredential } from "@circle-fin/modular-wallets-core";
import type { PasskeyChainRuntime, PasskeyRuntimeSet } from "@/lib/circle-passkey";
import {
  ensureBackendWallet,
  initializeBackendWallets,
  syncBackendWallets,
} from "@/lib/backend-wallets";
import { buildBackendUrl, resolveBackendBaseUrl } from "@/lib/backend-api";
import { readStoredPasskeyCredential } from "@/lib/circle-passkey";
import {
  SUPPORTED_WALLET_CHAINS,
  isPasskeySession,
  getErrorMessage,
  clearCircleOAuthBackups,
  writeStoredJson,
  type CircleUserWallet,
  type CircleW3SSession,
  type CircleSession,
  type W3SSdkInstance,
} from "@/services/circle-auth.service";

export interface WalletLoaderDeps {
  session: CircleSession | null;
  sdkRef: React.MutableRefObject<W3SSdkInstance | null>;
  executePasskeyChallenge: (challengeId: string) => Promise<unknown>;
  initializePasskeyWallets: (args: {
    credential?: WebAuthnCredential | null;
    username: string | null;
  }) => Promise<PasskeyRuntimeSet>;
  resetPasskeyRuntimeState: () => void;
  passkeyRuntimeByWalletIdRef: React.MutableRefObject<Map<string, PasskeyChainRuntime>>;
  setWallets: (v: CircleUserWallet[]) => void;
  setArcWallet: (v: CircleUserWallet | null) => void;
  setSepoliaWallet: (v: CircleUserWallet | null) => void;
  setSolanaWallet: (v: CircleUserWallet | null) => void;
  setAuthError: (v: string | null) => void;
  setAuthStatus: (v: string | null) => void;
  setIsAuthenticating: (v: boolean) => void;
  setIsLoginOpen: (v: boolean) => void;
  clearStoredLoginConfig: (opts?: { preserveGoogleCookies?: boolean }) => void;
  authRequestInFlightRef: React.MutableRefObject<boolean>;
}

export function useWalletLoader({
  session,
  sdkRef,
  executePasskeyChallenge,
  initializePasskeyWallets,
  resetPasskeyRuntimeState,
  passkeyRuntimeByWalletIdRef,
  setWallets,
  setArcWallet,
  setSepoliaWallet,
  setSolanaWallet,
  setAuthError,
  setAuthStatus,
  setIsAuthenticating,
  setIsLoginOpen,
  clearStoredLoginConfig,
  authRequestInFlightRef,
}: WalletLoaderDeps) {
  const ensuredSolanaByUserTokenRef = useRef(new Set<string>());

  const postW3sAction = useCallback(
    async (action: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(
        buildBackendUrl("/w3s/action", resolveBackendBaseUrl()),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action, ...params }),
        },
      );

      const payload = (await response.json().catch(() => ({}))) as {
        code?: number;
        error?: string;
        message?: string;
        retryAfterMs?: number | null;
        status?: number;
        [key: string]: unknown;
      };

      if (!response.ok) {
        const retryAfterSeconds =
          typeof payload.retryAfterMs === "number"
            ? Math.max(1, Math.ceil(payload.retryAfterMs / 1000))
            : null;
        const fallbackMessage =
          response.status === 429
            ? `Circle rate limit reached while running ${action}.${retryAfterSeconds ? ` Retry in about ${retryAfterSeconds}s.` : " Retry in a few seconds."}`
            : `Circle action failed: ${action}`;
        const nextError = new Error(
          payload.error || payload.message || fallbackMessage,
        ) as Error & {
          code?: number;
          retryAfterMs?: number | null;
          status?: number;
        };
        nextError.code = payload.code;
        nextError.retryAfterMs = payload.retryAfterMs;
        nextError.status = response.status;
        throw nextError;
      }

      return payload;
    },
    [],
  );

  const loadWallets = useCallback(
    async (authSessionOverride?: CircleSession | null) => {
      const activeSession = authSessionOverride ?? session;

      if (isPasskeySession(activeSession)) {
        const storedCredential = readStoredPasskeyCredential();

        if (!storedCredential) {
          throw new Error(
            "Your saved passkey session is incomplete. Sign in with Passkey again.",
          );
        }

        await initializePasskeyWallets({
          credential: storedCredential,
          username: activeSession.passkeyUsername,
        });

        return (
          passkeyRuntimeByWalletIdRef.current.size > 0
            ? Array.from(passkeyRuntimeByWalletIdRef.current.values()).map(
                (runtime) => runtime.wallet as CircleUserWallet,
              )
            : []
        ) as CircleUserWallet[];
      }

      const userToken = activeSession?.userToken;

      if (!userToken) {
        setWallets([]);
        setArcWallet(null);
        setSepoliaWallet(null);
        setSolanaWallet(null);
        resetPasskeyRuntimeState();
        return [] as CircleUserWallet[];
      }

      const { wallets: syncedWallets } = await syncBackendWallets({
        email: activeSession.email,
        userToken,
      });

      const nextWallets = syncedWallets.filter((wallet) =>
        SUPPORTED_WALLET_CHAINS.has(wallet.blockchain),
      );

      setWallets(nextWallets);
      setArcWallet(
        nextWallets.find((wallet) => wallet.blockchain === "ARC-TESTNET") ??
          null,
      );
      setSepoliaWallet(
        nextWallets.find((wallet) => wallet.blockchain === "ETH-SEPOLIA") ??
          null,
      );
      setSolanaWallet(
        nextWallets.find((wallet) => wallet.blockchain === "SOLANA-DEVNET") ??
          null,
      );

      // Cache Solana wallet address so passkey sessions can show it.
      const nextSolanaWallet = nextWallets.find(
        (wallet) => wallet.blockchain === "SOLANA-DEVNET",
      );
      if (nextSolanaWallet) {
        writeStoredJson("solana_wallet_cache", {
          address: nextSolanaWallet.address,
          blockchain: nextSolanaWallet.blockchain,
          id: nextSolanaWallet.id,
        });
      }

      return nextWallets;
    },
    [
      initializePasskeyWallets,
      passkeyRuntimeByWalletIdRef,
      resetPasskeyRuntimeState,
      session,
      setArcWallet,
      setSepoliaWallet,
      setSolanaWallet,
      setWallets,
    ],
  );

  const executeChallengeForSession = useCallback(
    async (challengeId: string, authSession: CircleSession) => {
      if (isPasskeySession(authSession)) {
        return executePasskeyChallenge(challengeId);
      }

      const sdk = sdkRef.current;

      if (!sdk) {
        throw new Error("Circle Web SDK is not ready yet.");
      }

      sdk.setAuthentication({
        userToken: authSession.userToken,
        encryptionKey: authSession.encryptionKey,
      });

      return new Promise<unknown>((resolve, reject) => {
        sdk.execute(challengeId, (error, result) => {
          if (error) {
            const nextError = new Error(getErrorMessage(error)) as Error & {
              code?: number | string;
              raw?: unknown;
            };

            if (isRecord(error) && (typeof error.code === "number" || typeof error.code === "string")) {
              nextError.code = error.code;
            } else if (
              isRecord(error) &&
              isRecord(error.error) &&
              (typeof error.error.code === "number" || typeof error.error.code === "string")
            ) {
              nextError.code = error.error.code;
            }

            nextError.raw = error;
            reject(nextError);
            return;
          }

          resolve(result);
        });
      });
    },
    [executePasskeyChallenge, sdkRef],
  );

  const loadWalletsEnsuringSolana = useCallback(
    async (authSession: CircleSession) => {
      const existingWallets = await loadWallets(authSession);

      if (isPasskeySession(authSession)) {
        return existingWallets;
      }

      if (
        existingWallets.some((wallet) => wallet.blockchain === "SOLANA-DEVNET")
      ) {
        ensuredSolanaByUserTokenRef.current.add(authSession.userToken);
        return existingWallets;
      }

      if (ensuredSolanaByUserTokenRef.current.has(authSession.userToken)) {
        return existingWallets;
      }

      try {
        setAuthStatus("Creating your Solana Devnet user wallet...");

        const response = await ensureBackendWallet({
          chain: "SOLANA",
          email: authSession.email,
          userToken: authSession.userToken,
        });

        if (!response.requiresUserApproval) {
          if (response.wallet) {
            ensuredSolanaByUserTokenRef.current.add(authSession.userToken);
            return loadWallets(authSession);
          }

          return existingWallets;
        }

        const challengeId = response.challengeId;

        if (!challengeId) {
          return existingWallets;
        }

        setAuthStatus("Confirming Solana wallet challenge...");
        await executeChallengeForSession(challengeId, authSession);
        await new Promise((resolve) => {
          window.setTimeout(resolve, 1500);
        });

        setAuthStatus("Loading Circle wallets...");
        const updatedWallets = await loadWallets(authSession);

        if (
          updatedWallets.some((wallet) => wallet.blockchain === "SOLANA-DEVNET")
        ) {
          ensuredSolanaByUserTokenRef.current.add(authSession.userToken);
        }

        return updatedWallets;
      } catch (error) {
        console.warn(
          "[CircleWalletProvider] Failed to auto-create Solana user wallet",
          error,
        );
        return existingWallets;
      }
    },
    [executeChallengeForSession, loadWallets, setAuthStatus],
  );

  const initializeAndLoadWallets = useCallback(
    async (authSession: CircleW3SSession) => {
      setIsAuthenticating(true);
      setAuthError(null);
      setAuthStatus("Initializing your Circle wallet...");

      try {
        const payload = await initializeBackendWallets({
          email: authSession.email,
          userToken: authSession.userToken,
        });

        if (payload.challengeId) {
          setAuthStatus(
            "Circle wallet challenge ready. Confirm it to finish setup.",
          );
          await executeChallengeForSession(payload.challengeId, authSession);
          await new Promise((resolve) => {
            window.setTimeout(resolve, 1500);
          });
        }

        setAuthStatus("Loading Circle wallets...");
        await loadWalletsEnsuringSolana(authSession);
        setAuthStatus("Circle wallet ready.");
        setIsLoginOpen(false);
        clearCircleOAuthBackups();
        clearStoredLoginConfig({ preserveGoogleCookies: true });
      } catch (error) {
        const code = (error as Error & { code?: number | string }).code;

        if (code === 155106 || code === "155106") {
          setAuthStatus("Existing Circle wallet found. Loading wallets...");
          await loadWalletsEnsuringSolana(authSession);
          setAuthStatus("Circle wallet restored.");
          setIsLoginOpen(false);
          clearCircleOAuthBackups();
          clearStoredLoginConfig({ preserveGoogleCookies: true });
          setIsAuthenticating(false);
          return;
        }

        setAuthError(getErrorMessage(error));
      } finally {
        authRequestInFlightRef.current = false;
        setIsAuthenticating(false);
      }
    },
    [
      authRequestInFlightRef,
      clearStoredLoginConfig,
      executeChallengeForSession,
      loadWalletsEnsuringSolana,
      setAuthError,
      setAuthStatus,
      setIsAuthenticating,
      setIsLoginOpen,
    ],
  );

  return {
    postW3sAction,
    loadWallets,
    executeChallengeForSession,
    loadWalletsEnsuringSolana,
    initializeAndLoadWallets,
  };
}
