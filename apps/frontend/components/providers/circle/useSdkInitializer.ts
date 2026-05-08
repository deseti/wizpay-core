"use client";

import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { PASSKEY_CONFIG } from "@/services/circle-auth.service";
import { getPasskeySupportError } from "@/lib/circle-passkey";
import {
  readStoredJson,
  isW3SLoginCompleteResult,
  getGoogleOAuthDiagnostics,
  getRestoredCircleAppId,
  readGoogleLoginConfigFromCookies,
  restoreCircleOAuthStateFromCookies,
  SESSION_STORAGE_KEY,
  LOGIN_CONFIG_STORAGE_KEY,
  type CircleSession,
  type CircleW3SSession,
  type StoredLoginConfig,
  type GoogleOAuthDiagnostics,
  type W3SSdkInstance,
  type W3SSdkModule,
} from "@/services/circle-auth.service";

export interface SdkInitializerDeps {
  sdkRef: React.MutableRefObject<W3SSdkInstance | null>;
  loginConfigRef: React.MutableRefObject<StoredLoginConfig | null>;
  googleOAuthDiagnosticsRef: React.MutableRefObject<GoogleOAuthDiagnostics | null>;
  handleAuthFailure: (error: unknown) => void;
  initializeAndLoadWallets: (authSession: CircleW3SSession) => Promise<void>;
  persistSession: (nextSession: CircleSession | null) => void;
  setHasPendingEmailOtp: (v: boolean) => void;
  setIsAuthenticating: (v: boolean) => void;
  setPasskeyUnavailableReason: (v: string | null) => void;
  setReady: (v: boolean) => void;
  setAuthError: React.Dispatch<React.SetStateAction<string | null>>;
  setAuthStatus: (v: string | null) => void;
  setSession: (v: CircleSession | null) => void;
  ready: boolean;
  deviceId: string;
  ensureDeviceId: () => Promise<string>;
}

export function useSdkInitializer({
  sdkRef,
  loginConfigRef,
  googleOAuthDiagnosticsRef,
  handleAuthFailure,
  initializeAndLoadWallets,
  persistSession,
  setHasPendingEmailOtp,
  setIsAuthenticating,
  setPasskeyUnavailableReason,
  setReady,
  setAuthError,
  setAuthStatus,
  setSession,
  ready,
  deviceId,
  ensureDeviceId,
}: SdkInitializerDeps) {
  // Stable refs so SDK callback closures don't go stale
  const handleAuthFailureRef = useRef<((error: unknown) => void) | null>(null);
  const initializeAndLoadWalletsRef = useRef<
    ((authSession: CircleW3SSession) => Promise<void>) | null
  >(null);
  const persistSessionRef = useRef<
    ((nextSession: CircleSession | null) => void) | null
  >(null);
  const initInFlightRef = useRef<Promise<W3SSdkInstance | null> | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    handleAuthFailureRef.current = handleAuthFailure;
  }, [handleAuthFailure]);

  useEffect(() => {
    initializeAndLoadWalletsRef.current = initializeAndLoadWallets;
  }, [initializeAndLoadWallets]);

  useEffect(() => {
    persistSessionRef.current = persistSession;
  }, [persistSession]);

  useEffect(() => {
    unmountedRef.current = false;

    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Restore persisted session from localStorage on first mount
  useEffect(() => {
    const storedSession = readStoredJson<CircleSession>(SESSION_STORAGE_KEY);
    const storedLoginConfig = readStoredJson<StoredLoginConfig>(
      LOGIN_CONFIG_STORAGE_KEY,
    );

    if (storedSession?.authMethod === "passkey") {
      persistSession(null);
      setSession(null);
    } else if (storedSession) {
      setSession(storedSession);
    }

    if (storedLoginConfig) {
      loginConfigRef.current = storedLoginConfig;
      setHasPendingEmailOtp(storedLoginConfig.loginMethod === "email");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect passkey platform support on mount
  useEffect(() => {
    setPasskeyUnavailableReason(getPasskeySupportError(PASSKEY_CONFIG));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initializeSdk = useCallback(
    async (options?: { force?: boolean }) => {
      if (initInFlightRef.current && !options?.force) {
        return initInFlightRef.current;
      }

      const nextPromise = (async () => {
        if (options?.force) {
          sdkRef.current = null;
          if (!unmountedRef.current) {
            setReady(false);
          }
        }

      try {
        const sdkModule =
          (await import("@circle-fin/w3s-pw-web-sdk")) as unknown as W3SSdkModule;

        if (!sdkModule.W3SSdk) {
          throw new Error("Circle Web SDK did not expose W3SSdk.");
        }

        restoreCircleOAuthStateFromCookies();

        const restoredLoginConfig =
          loginConfigRef.current ??
          readStoredJson<StoredLoginConfig>(LOGIN_CONFIG_STORAGE_KEY) ??
          readGoogleLoginConfigFromCookies();

        if (restoredLoginConfig) {
          loginConfigRef.current = restoredLoginConfig;

          if (!unmountedRef.current) {
            setHasPendingEmailOtp(restoredLoginConfig.loginMethod === "email");
          }
        }

        googleOAuthDiagnosticsRef.current =
          getGoogleOAuthDiagnostics(restoredLoginConfig);

        const initialConfig: Record<string, unknown> = {
          appSettings: { appId: getRestoredCircleAppId() },
        };

        if (restoredLoginConfig?.loginConfigs) {
          initialConfig.loginConfigs = restoredLoginConfig.loginConfigs;
        }

        const sdk = new sdkModule.W3SSdk(initialConfig, (error, result) => {
          if (unmountedRef.current) {
            return;
          }

          if (error || !isW3SLoginCompleteResult(result)) {
            setIsAuthenticating(false);
            handleAuthFailureRef.current?.(
              error ??
                new Error("Circle login did not return a valid auth payload."),
            );
            return;
          }

          googleOAuthDiagnosticsRef.current = null;

          const storedLoginConfigForCallback = loginConfigRef.current;
          const nextSession: CircleSession = {
            authMethod: storedLoginConfigForCallback?.loginMethod ?? "google",
            email: storedLoginConfigForCallback?.email ?? null,
            encryptionKey: result.encryptionKey,
            refreshToken: result.refreshToken,
            userToken: result.userToken,
          };

          setSession(nextSession);
          persistSessionRef.current?.(nextSession);

          if (initializeAndLoadWalletsRef.current) {
            void initializeAndLoadWalletsRef.current(nextSession);
          }
        });

        sdkRef.current = sdk;

        if (!unmountedRef.current) {
          setReady(true);
          setAuthStatus(null);
        }

        return sdk;
      } catch (error) {
        if (!unmountedRef.current) {
          setReady(true);
          handleAuthFailureRef.current?.(error);
        }

        return null;
      }
      })();

      initInFlightRef.current = nextPromise;

      try {
        return await nextPromise;
      } finally {
        if (initInFlightRef.current === nextPromise) {
          initInFlightRef.current = null;
        }
      }
    },
    [googleOAuthDiagnosticsRef, loginConfigRef, sdkRef, setAuthStatus, setHasPendingEmailOtp, setIsAuthenticating, setReady, setSession],
  );

  // Dynamically load and initialize the Circle W3S SDK
  useEffect(() => {
    void initializeSdk();
  }, [initializeSdk]);

  // Pre-fetch device ID as soon as SDK is ready so logins don't pay the round-trip cost
  useEffect(() => {
    if (!ready || deviceId) {
      return;
    }

    let cancelled = false;

    async function fetchDeviceId() {
      try {
        await ensureDeviceId();

        if (!cancelled) {
          setAuthError((current: string | null) =>
            current ===
            "Circle device ID is still loading. Try again in a moment."
              ? null
              : current,
          );
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Unknown error";

          // Surface a clear, actionable message when the server-side API key
          // is missing — this is the most common Docker misconfiguration.
          if (
            message.includes("CIRCLE_API_KEY") ||
            message.includes("createDeviceToken") ||
            message.includes("Circle action failed")
          ) {
            console.error(
              "[CircleWalletProvider] createDeviceToken failed. " +
                "Check that CIRCLE_API_KEY is set in root .env and the Docker " +
                "container was restarted. Also verify http://localhost:3000 is " +
                "listed in Circle Console → Allowed Origins.",
              error,
            );
            setAuthError(
              "Authentication initialization failed. " +
                "The server CIRCLE_API_KEY may be missing or the Circle App ID may not " +
                "allow localhost:3000. Check server logs and Circle Console.",
            );
          } else {
            handleAuthFailure(error);
          }
        }
      }
    }

    void fetchDeviceId();

    return () => {
      cancelled = true;
    };
  }, [deviceId, ensureDeviceId, handleAuthFailure, ready, setAuthError]);

  return {
    reinitializeSdk: useCallback(
      async () => initializeSdk({ force: true }),
      [initializeSdk],
    ),
  };
}
