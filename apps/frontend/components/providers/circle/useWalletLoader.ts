"use client";

import { useCallback, useRef } from "react";
import type React from "react";
import type { WebAuthnCredential } from "@circle-fin/modular-wallets-core";
import type {
  PasskeyChainRuntime,
  PasskeyRuntimeSet,
} from "@/lib/circle-passkey";
import {
  initializeBackendWallets,
  selectBackendWalletForBlockchain,
  syncBackendWallets,
} from "@/lib/backend-wallets";
import { buildBackendUrl, resolveBackendBaseUrl } from "@/lib/backend-api";
import {
  CIRCLE_ACTION_TIMEOUT_MS,
  CIRCLE_EXECUTE_TIMEOUT_MS,
  CIRCLE_WALLET_LOAD_TIMEOUT_MS,
  withCircleTimeout,
  type CircleInitializationPhase,
} from "@/lib/circle-runtime";
import { readStoredPasskeyCredential } from "@/lib/circle-passkey";
import {
  SUPPORTED_WALLET_CHAINS,
  isPasskeySession,
  isRecord,
  getErrorMessage,
  clearCircleOAuthBackups,
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
  passkeyRuntimeByWalletIdRef: React.MutableRefObject<
    Map<string, PasskeyChainRuntime>
  >;
  setWallets: (v: CircleUserWallet[]) => void;
  setArcWallet: (v: CircleUserWallet | null) => void;
  setSepoliaWallet: (v: CircleUserWallet | null) => void;
  setAuthError: (v: string | null) => void;
  setAuthStatus: (v: string | null) => void;
  setInitializationPhase: (v: CircleInitializationPhase) => void;
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
  setAuthError,
  setAuthStatus,
  setInitializationPhase,
  setIsAuthenticating,
  setIsLoginOpen,
  clearStoredLoginConfig,
  authRequestInFlightRef,
}: WalletLoaderDeps) {
  const walletLoadInFlightRef = useRef<Promise<CircleUserWallet[]> | null>(
    null,
  );
  const walletInitializationInFlightRef = useRef<Promise<void> | null>(null);

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
          signal: AbortSignal.timeout(CIRCLE_ACTION_TIMEOUT_MS),
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

  const loadWalletsUncached = useCallback(
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
        resetPasskeyRuntimeState();
        return [] as CircleUserWallet[];
      }

      setInitializationPhase("syncing_wallets");
      const { wallets: syncedWallets } = await withCircleTimeout(
        syncBackendWallets(
          {
            email: activeSession.email,
            userToken,
          },
          AbortSignal.timeout(CIRCLE_WALLET_LOAD_TIMEOUT_MS),
        ),
        CIRCLE_WALLET_LOAD_TIMEOUT_MS,
        "syncing_wallets",
      );

      const nextWallets = syncedWallets.filter((wallet) =>
        SUPPORTED_WALLET_CHAINS.has(wallet.blockchain),
      );

      setWallets(nextWallets);
      setArcWallet(selectBackendWalletForBlockchain(nextWallets, "ARC-TESTNET"));
      setSepoliaWallet(selectBackendWalletForBlockchain(nextWallets, "ETH-SEPOLIA"));
      setInitializationPhase("ready");
      return nextWallets;
    },
    [
      initializePasskeyWallets,
      passkeyRuntimeByWalletIdRef,
      resetPasskeyRuntimeState,
      session,
      setArcWallet,
      setSepoliaWallet,
      setInitializationPhase,
      setWallets,
    ],
  );

  const loadWallets = useCallback(
    async (authSessionOverride?: CircleSession | null) => {
      if (walletLoadInFlightRef.current) return walletLoadInFlightRef.current;
      const next = withCircleTimeout(
        loadWalletsUncached(authSessionOverride),
        CIRCLE_WALLET_LOAD_TIMEOUT_MS,
        "syncing_wallets",
      );
      walletLoadInFlightRef.current = next;
      try {
        return await next;
      } finally {
        if (walletLoadInFlightRef.current === next)
          walletLoadInFlightRef.current = null;
      }
    },
    [loadWalletsUncached],
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

      return withCircleTimeout(
        new Promise<unknown>((resolve, reject) => {
          sdk.execute(challengeId, (error, result) => {
            if (error) {
              const nextError = new Error(getErrorMessage(error)) as Error & {
              code?: number | string;
              raw?: unknown;
            };

              if (
                isRecord(error) &&
                (typeof error.code === "number" ||
                  typeof error.code === "string")
              ) {
                nextError.code = error.code;
              } else if (
              isRecord(error) &&
              isRecord(error.error) &&
              (typeof error.error.code === "number" ||
                typeof error.error.code === "string")
            ) {
              nextError.code = error.error.code;
            }

            nextError.raw = error;
            reject(nextError);
            return;
          }

            resolve(result);
          });
        }),
        CIRCLE_EXECUTE_TIMEOUT_MS,
        "initializing_wallets",
      );
    },
    [executePasskeyChallenge, sdkRef],
  );

  const loadWalletsForArcStartup = loadWallets;

  const initializeAndLoadWallets = useCallback(
    async (authSession: CircleW3SSession) => {
      if (walletInitializationInFlightRef.current)
        return walletInitializationInFlightRef.current;
      const initialization = (async () => {
        setIsAuthenticating(true);
        setAuthError(null);
        setAuthStatus("Initializing your Circle wallet...");
        setInitializationPhase("initializing_wallets");

        try {
          const payload = await initializeBackendWallets(
            {
              email: authSession.email,
              userToken: authSession.userToken,
            },
            AbortSignal.timeout(CIRCLE_WALLET_LOAD_TIMEOUT_MS),
          );

          if (payload.challengeId) {
            setAuthStatus(
              "Circle wallet challenge ready. Confirm it to finish setup.",
            );
            await executeChallengeForSession(payload.challengeId, authSession);
          }

          setAuthStatus("Loading Circle wallets...");
          await loadWalletsForArcStartup(authSession);
          setAuthStatus("Circle wallet ready.");
          setIsLoginOpen(false);
          clearCircleOAuthBackups();
        clearStoredLoginConfig({ preserveGoogleCookies: true });
      } catch (error) {
        const code = (error as Error & { code?: number | string }).code;

          if (code === 155106 || code === "155106") {
            setAuthStatus("Existing Circle wallet found. Loading wallets...");
            await loadWalletsForArcStartup(authSession);
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
      })();
      walletInitializationInFlightRef.current = initialization;
      try {
        await initialization;
      } finally {
        if (walletInitializationInFlightRef.current === initialization)
          walletInitializationInFlightRef.current = null;
      }
    },
    [
      authRequestInFlightRef,
      clearStoredLoginConfig,
      executeChallengeForSession,
      loadWalletsForArcStartup,
      setAuthError,
      setAuthStatus,
      setInitializationPhase,
      setIsAuthenticating,
      setIsLoginOpen,
    ],
  );

  return {
    postW3sAction,
    loadWallets,
    executeChallengeForSession,
    loadWalletsForArcStartup,
    initializeAndLoadWallets,
  };
}
