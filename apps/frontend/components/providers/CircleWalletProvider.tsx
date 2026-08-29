"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearStoredPasskeyCredential,
  createPasskeyRuntimeSet,
  readStoredPasskeyCredential,
  readStoredPasskeyUsername,
  sendPasskeyUserOperation,
  signPasskeyTypedData,
  storePasskeyCredential,
  storePasskeyUsername,
  type PasskeyChainRuntime,
  type PasskeyRuntimeSet,
} from "@/lib/circle-passkey";
import {
  CIRCLE_DEVICE_ID_TIMEOUT_MS,
  shouldRefreshCircleToken,
  withCircleTimeout,
  type CircleInitializationPhase,
} from "@/lib/circle-runtime";

import { LoginModal } from "./circle/LoginModal";
import { usePasskeyAuth } from "./circle/usePasskeyAuth";
import { useGoogleAuth } from "./circle/useGoogleAuth";
import { useEmailAuth } from "./circle/useEmailAuth";
import { useWalletLoader } from "./circle/useWalletLoader";
import { useChallengeActions } from "./circle/useChallengeActions";
import { useSdkInitializer } from "./circle/useSdkInitializer";
import { useCircleMobileRecovery } from "./circle/useMobileRecovery";
import type {
  CircleUserWallet,
  CircleW3SSession,
  CirclePasskeySession,
  CircleSession,
  CirclePasskeyChallenge,
  StoredLoginConfig,
  GoogleOAuthDiagnostics,
  W3SSdkInstance,
  CircleWalletContextValue,
} from "@/services/circle-auth.service";
import {
  CIRCLE_APP_ID,
  GOOGLE_CLIENT_ID,
  PASSKEY_ENABLED,
  PASSKEY_CONFIG,
  INVALID_DEVICE_ERROR_CODES,
  OAUTH_RECOVERY_ERROR_CODES,
  getErrorMessage,
  isRecord,
  isPasskeySession,
  writeStoredJson,
  removeStoredValue,
  getRestoredCircleAppId,
  clearGoogleLoginCookies,
  clearCircleOAuthState,
  DEVICE_ID_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  LOGIN_CONFIG_STORAGE_KEY,
  isDefinitiveCircleRefreshFailure,
  mergeCircleRefreshedSession,
} from "@/services/circle-auth.service";

export const CircleWalletContext =
  createContext<CircleWalletContextValue | null>(null);

const MOBILE_AUTH_UA_REGEX = /android|iphone|ipad|ipod|mobile/i;

function isMobileOrStandaloneAuthRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    MOBILE_AUTH_UA_REGEX.test(window.navigator.userAgent) ||
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

export function CircleWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // If CIRCLE_APP_ID is not configured, skip SDK initialization entirely.
  // Google and OTP logins both require Circle SDK, so we render a no-op
  // context that signals auth is unavailable rather than crashing.
  if (!CIRCLE_APP_ID) {
    console.warn(
      "[CircleWalletProvider] NEXT_PUBLIC_CIRCLE_APP_ID is not set. " +
        "Auth is disabled. Set it in .env and rebuild the Docker image.",
    );
    return (
      <CircleWalletContext.Provider value={DISABLED_CONTEXT_VALUE}>
        {children}
      </CircleWalletContext.Provider>
    );
  }

  return <CircleWalletProviderInner>{children}</CircleWalletProviderInner>;
}

const DISABLED_CONTEXT_VALUE: CircleWalletContextValue = {
  arcWallet: null,
  authMethod: null,
  authError:
    "Circle App ID is not configured. Set NEXT_PUBLIC_CIRCLE_APP_ID and rebuild.",
  authStatus: null,
  authenticated: false,
  closeLogin: () => {},
  createContractExecutionChallenge: async () => {
    throw new Error("Auth not configured.");
  },
  createTypedDataChallenge: async () => {
    throw new Error("Auth not configured.");
  },
  createTransferChallenge: async () => {
    throw new Error("Auth not configured.");
  },
  ensureSessionReady: async () => {},
  executeChallenge: async () => {
    throw new Error("Auth not configured.");
  },
  getWalletBalances: async () => [],
  hasPendingEmailOtp: false,
  isAuthenticating: false,
  initializationPhase: "recoverable_error",
  login: () => {},
  loginMethodLabel: "Circle",
  logout: () => {},
  primaryWallet: null,
  ready: false,
  refreshWallets: async () => {},
  requestEmailOtp: async () => {},
  requestGoogleLogin: async () => {},
  requestPasskeyLogin: async () => {},
  requestPasskeyRegistration: async () => {},
  sepoliaWallet: null,
  userEmail: null,
  userToken: null,
  verifyEmailOtp: () => {},
  wallets: [],
};

function CircleWalletProviderInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const sdkRef = useRef<W3SSdkInstance | null>(null);
  const loginConfigRef = useRef<StoredLoginConfig | null>(null);
  const googleOAuthDiagnosticsRef = useRef<GoogleOAuthDiagnostics | null>(null);
  const authRequestInFlightRef = useRef(false);
  const deviceIdInFlightRef = useRef<Promise<string> | null>(null);
  const refreshInFlightRef = useRef<Promise<CircleW3SSession> | null>(null);
  const passkeyChallengeStoreRef = useRef(
    new Map<string, CirclePasskeyChallenge>(),
  );
  const passkeyRuntimeByWalletIdRef = useRef(
    new Map<string, PasskeyChainRuntime>(),
  );

  const [arcWallet, setArcWallet] = useState<CircleUserWallet | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [hasPendingEmailOtp, setHasPendingEmailOtp] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [initializationPhase, setInitializationPhase] =
    useState<CircleInitializationPhase>("waiting_for_document");
  const [isCircleVerificationActive, setIsCircleVerificationActive] =
    useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [passkeyUnavailableReason, setPasskeyUnavailableReason] = useState<
    string | null
  >(null);
  const [ready, setReady] = useState(false);
  const [sepoliaWallet, setSepoliaWallet] = useState<CircleUserWallet | null>(
    null,
  );
  const [session, setSession] = useState<CircleSession | null>(null);
  const [wallets, setWallets] = useState<CircleUserWallet[]>([]);

  const resetDeviceId = useCallback(() => {
    setDeviceId("");
    removeStoredValue(DEVICE_ID_STORAGE_KEY);
  }, []);

  const handleAuthFailure = useCallback(
    (error: unknown) => {
      const code =
        (isRecord(error) && typeof error.code === "number"
          ? error.code
          : null) ??
        (isRecord(error) &&
        isRecord(error.error) &&
        typeof error.error.code === "number"
          ? error.error.code
          : null) ??
        null;

      authRequestInFlightRef.current = false;

      if (INVALID_DEVICE_ERROR_CODES.has(code ?? -1)) {
        resetDeviceId();
        clearGoogleLoginCookies();
      }

      if (OAUTH_RECOVERY_ERROR_CODES.has(code ?? -1)) {
        clearCircleOAuthState();
      }

      setAuthError(getErrorMessage(error, googleOAuthDiagnosticsRef.current));
      setAuthStatus(null);
    },
    [resetDeviceId],
  );

  const ensureDeviceId = useCallback(async () => {
    if (deviceId) {
      return deviceId;
    }

    const cachedDeviceId =
      typeof window !== "undefined"
        ? window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
        : null;

    if (cachedDeviceId) {
      setDeviceId(cachedDeviceId);
      return cachedDeviceId;
    }

    const sdk = sdkRef.current;

    if (!sdk) {
      throw new Error("Circle Web SDK is not ready yet.");
    }

    if (deviceIdInFlightRef.current) {
      return deviceIdInFlightRef.current;
    }

    const nextDeviceIdPromise = (async () => {
      const nextDeviceId = await withCircleTimeout(
        sdk.getDeviceId(),
        CIRCLE_DEVICE_ID_TIMEOUT_MS,
        "restoring_session",
      );

      if (!nextDeviceId) {
        throw new Error("Circle device ID is unavailable.");
      }

      setDeviceId(nextDeviceId);

      if (typeof window !== "undefined") {
        window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, nextDeviceId);
      }

      return nextDeviceId;
    })();

    deviceIdInFlightRef.current = nextDeviceIdPromise;

    try {
      return await nextDeviceIdPromise;
    } finally {
      if (deviceIdInFlightRef.current === nextDeviceIdPromise) {
        deviceIdInFlightRef.current = null;
      }
    }
  }, [deviceId]);

  const persistSession = useCallback((nextSession: CircleSession | null) => {
    if (nextSession) {
      writeStoredJson(SESSION_STORAGE_KEY, nextSession);
      return;
    }

    removeStoredValue(SESSION_STORAGE_KEY);
  }, []);

  const clearStoredLoginConfig = useCallback(
    (options?: { preserveGoogleCookies?: boolean }) => {
      loginConfigRef.current = null;
      setHasPendingEmailOtp(false);
      removeStoredValue(LOGIN_CONFIG_STORAGE_KEY);

      if (!options?.preserveGoogleCookies) {
        clearGoogleLoginCookies();
      }
    },
    [],
  );

  const storeLoginConfig = useCallback((value: StoredLoginConfig) => {
    loginConfigRef.current = value;
    writeStoredJson(LOGIN_CONFIG_STORAGE_KEY, value);
    setHasPendingEmailOtp(value.loginMethod === "email");
  }, []);

  const applyPasskeyRuntimeSet = useCallback(
    (runtimeSet: PasskeyRuntimeSet | null) => {
      passkeyRuntimeByWalletIdRef.current = runtimeSet?.byWalletId ?? new Map();

      const nextWallets = (runtimeSet?.wallets ?? []) as CircleUserWallet[];

      setWallets(nextWallets);
      setArcWallet(
        (runtimeSet?.arc?.wallet as CircleUserWallet | null) ?? null,
      );
      setSepoliaWallet(
        (runtimeSet?.sepolia?.wallet as CircleUserWallet | null) ?? null,
      );
    },
    [],
  );

  const resetPasskeyRuntimeState = useCallback(() => {
    passkeyChallengeStoreRef.current.clear();
    passkeyRuntimeByWalletIdRef.current.clear();
  }, []);

  const clearPasskeyState = useCallback(() => {
    resetPasskeyRuntimeState();
    clearStoredPasskeyCredential();
    storePasskeyUsername(null);
  }, [resetPasskeyRuntimeState]);
  const initializePasskeyWallets = useCallback(
    async ({
      credential,
      username,
    }: {
      credential?: ReturnType<typeof readStoredPasskeyCredential>;
      username: string | null;
    }) => {
      const nextCredential = credential ?? readStoredPasskeyCredential();

      if (!nextCredential) {
        throw new Error(
          "No stored passkey credential was found. Sign in with Passkey again.",
        );
      }

      const runtimeSet = await createPasskeyRuntimeSet({
        config: PASSKEY_CONFIG,
        credential: nextCredential,
        username,
      });

      applyPasskeyRuntimeSet(runtimeSet);

      return runtimeSet;
    },
    [applyPasskeyRuntimeSet],
  );

  const finalizePasskeyAuthentication = useCallback(
    async ({
      credential,
      username,
    }: {
      credential: NonNullable<ReturnType<typeof readStoredPasskeyCredential>>;
      username: string | null;
    }) => {
      const nextUsername = username ?? readStoredPasskeyUsername();

      await initializePasskeyWallets({
        credential,
        username: nextUsername,
      });

      storePasskeyCredential(credential);
      storePasskeyUsername(nextUsername);

      const nextSession: CirclePasskeySession = {
        authMethod: "passkey",
        email: null,
        passkeyUsername: nextUsername,
      };

      setSession(nextSession);
      persistSession(nextSession);
      clearCircleOAuthState();
      clearStoredLoginConfig({ preserveGoogleCookies: true });
      setAuthStatus("Circle passkey wallet ready.");
      setIsLoginOpen(false);
    },
    [clearStoredLoginConfig, initializePasskeyWallets, persistSession],
  );

  const executePasskeyChallenge = useCallback(async (challengeId: string) => {
    const pendingChallenge = passkeyChallengeStoreRef.current.get(challengeId);

    if (!pendingChallenge) {
      throw new Error("Passkey request expired. Retry the action.");
    }

    const runtime = passkeyRuntimeByWalletIdRef.current.get(
      pendingChallenge.walletId,
    );

    if (!runtime) {
      throw new Error("Passkey wallet session is not ready.");
    }

    try {
      if (pendingChallenge.kind === "contract") {
        const result = await sendPasskeyUserOperation({
          callData: pendingChallenge.callData,
          contractAddress: pendingChallenge.contractAddress,
          runtime,
        });
        const referenceId = pendingChallenge.referenceId ?? result.userOpHash;

        return {
          data: {
            id: referenceId,
            transactionHash: result.txHash,
            transactionId: referenceId,
            txHash: result.txHash,
            userOpHash: result.userOpHash,
          },
          id: referenceId,
          transactionHash: result.txHash,
          transactionId: referenceId,
          txHash: result.txHash,
          userOpHash: result.userOpHash,
        };
      }

      const signature = await signPasskeyTypedData({
        runtime,
        typedDataJson: pendingChallenge.typedDataJson,
      });

      return {
        data: { signature },
        signature,
      };
    } finally {
      passkeyChallengeStoreRef.current.delete(challengeId);
    }
  }, []);

  const {
    postW3sAction,
    loadWallets,
    executeChallengeForSession,
    loadWalletsForArcStartup,
    initializeAndLoadWallets,
  } = useWalletLoader({
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
  });

  const { reinitializeSdk } = useSdkInitializer({
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
    setInitializationPhase,
    setSession,
    ready,
    deviceId,
    ensureDeviceId,
  });

  const refreshCircleSession = useCallback(
    async (options?: { force?: boolean }) => {
      if (!session || isPasskeySession(session))
        throw new Error("Circle session is not available for refresh.");
      if (!options?.force && !shouldRefreshCircleToken(session.userToken))
        return session;
      if (refreshInFlightRef.current) return refreshInFlightRef.current;
      const current = session;
      const refresh = (async () => {
        if (!current.refreshToken)
          throw new Error("Circle session cannot be refreshed. Sign in again.");
        setInitializationPhase("refreshing_session");
        const currentDeviceId = await ensureDeviceId();
        try {
          const payload = await postW3sAction("refreshUserToken", {
            deviceId: currentDeviceId,
            refreshToken: current.refreshToken,
            userToken: current.userToken,
          });
          const next = mergeCircleRefreshedSession(current, payload);
          setSession(next);
          persistSession(next);
          setInitializationPhase("ready");
          setAuthError(null);
          return next;
        } catch (error) {
          if (isDefinitiveCircleRefreshFailure(error)) {
            persistSession(null);
            setSession(null);
            setWallets([]);
            setArcWallet(null);
            setSepoliaWallet(null);
            setInitializationPhase("reauthentication_required");
            setAuthError(
              "Your Circle session could not be refreshed. Sign in again to continue.",
            );
          } else {
            setInitializationPhase("recoverable_error");
          }
          throw error;
        }
      })();
      refreshInFlightRef.current = refresh;
      try {
        return await refresh;
      } finally {
        if (refreshInFlightRef.current === refresh)
          refreshInFlightRef.current = null;
      }
    },
    [ensureDeviceId, persistSession, postW3sAction, session],
  );

  useEffect(() => {
    if (!session || isPasskeySession(session)) return;
    const check = () => {
      if (shouldRefreshCircleToken(session.userToken))
        void refreshCircleSession().catch(() => {
          /* state communicates retry or reauthentication */
        });
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshCircleSession, session]);

  const resetActiveCircleSession = useCallback(
    (message: string) => {
      authRequestInFlightRef.current = false;
      clearCircleOAuthState();
      clearStoredLoginConfig({ preserveGoogleCookies: true });
      clearPasskeyState();
      persistSession(null);
      setArcWallet(null);
      setAuthError(message);
      setAuthStatus(null);
      setHasPendingEmailOtp(false);
      setIsAuthenticating(false);
      setSession(null);
      setSepoliaWallet(null);
      setWallets([]);
    },
    [clearPasskeyState, clearStoredLoginConfig, persistSession],
  );

  const rearmSdkForSession = useCallback(
    async (
      authSession: CircleSession,
      options?: { forceReinitialize?: boolean },
    ) => {
      if (isPasskeySession(authSession)) {
        return null;
      }

      const sdk = options?.forceReinitialize
        ? await reinitializeSdk()
        : (sdkRef.current ?? (await reinitializeSdk()));

      if (!sdk) {
        throw new Error("Circle Web SDK is not ready yet.");
      }

      const updatedConfig: Record<string, unknown> = {
        appSettings: { appId: getRestoredCircleAppId() },
      };

      if (loginConfigRef.current?.loginConfigs) {
        updatedConfig.loginConfigs = loginConfigRef.current.loginConfigs;
      }

      sdk.updateConfigs(updatedConfig);
      sdk.setAuthentication({
        encryptionKey: authSession.encryptionKey,
        userToken: authSession.userToken,
      });

      return sdk;
    },
    [reinitializeSdk],
  );

  const { ensureCircleSessionReady } = useCircleMobileRecovery({
    session,
    ready,
    authRequestInFlightRef,
    ensureDeviceId,
    handleAuthFailure,
    loadWalletsForArcStartup,
    refreshCircleSession,
    rearmSdkForSession,
    resetActiveCircleSession,
    setAuthError,
    setAuthStatus,
  });

  const {
    executeChallenge,
    createContractExecutionChallenge,
    createTransferChallenge,
    createTypedDataChallenge,
    getWalletBalances,
  } = useChallengeActions({
    session,
    ensureCircleSessionReady,
    postW3sAction,
    executeChallengeForSession,
    passkeyChallengeStoreRef,
    passkeyRuntimeByWalletIdRef,
  });

  useEffect(() => {
    const activeSession = session;
    if (!activeSession) {
      return;
    }

    let cancelled = false;

    async function hydrateWallets() {
      try {
        if (isPasskeySession(activeSession)) {
          await loadWallets(activeSession);
        } else {
          await loadWalletsForArcStartup(activeSession as CircleSession);
        }
      } catch (error) {
        if (!cancelled) {
          handleAuthFailure(error);
          clearPasskeyState();
          setSession(null);
          persistSession(null);
          setWallets([]);
          setArcWallet(null);
          setSepoliaWallet(null);
        }
      }
    }

    let visibilityTimer: number | null = null;
    const startHydration = () => {
      if (!cancelled && wallets.length === 0) void hydrateWallets();
    };
    const resumeVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", resumeVisible);
      if (visibilityTimer !== null) window.clearTimeout(visibilityTimer);
      setAuthError(null);
      startHydration();
    };
    if (document.visibilityState === "hidden") {
      queueMicrotask(() => {
        if (!cancelled) {
          setInitializationPhase("restoring_session");
          setAuthStatus(
            "Circle wallet synchronization is paused while this page is in the background.",
          );
        }
      });
      document.addEventListener("visibilitychange", resumeVisible);
      visibilityTimer = window.setTimeout(() => {
        if (!cancelled && document.visibilityState === "hidden") {
          setInitializationPhase("recoverable_error");
          setAuthError(
            "Circle wallet startup is paused because this page stayed in the background. Return to the page to resume.",
          );
        }
      }, 15_000);
    } else {
      startHydration();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", resumeVisible);
      if (visibilityTimer !== null) window.clearTimeout(visibilityTimer);
    };
  }, [
    clearPasskeyState,
    handleAuthFailure,
    loadWallets,
    loadWalletsForArcStartup,
    persistSession,
    session,
    wallets.length,
  ]);

  const { requestPasskeyLogin, requestPasskeyRegistration } = usePasskeyAuth({
    authRequestInFlightRef,
    setAuthError,
    setAuthStatus,
    setIsAuthenticating,
    resetPasskeyRuntimeState,
    handleAuthFailure,
    finalizePasskeyAuthentication,
  });

  const { requestGoogleLogin } = useGoogleAuth({
    authRequestInFlightRef,
    sdkRef,
    googleOAuthDiagnosticsRef,
    setAuthError,
    setAuthStatus,
    setIsAuthenticating,
    handleAuthFailure,
    ensureDeviceId,
    postW3sAction,
    storeLoginConfig,
    clearStoredLoginConfig,
  });

  const { requestEmailOtp, verifyEmailOtp } = useEmailAuth({
    authRequestInFlightRef,
    sdkRef,
    setAuthError,
    setAuthStatus,
    setIsAuthenticating,
    setIsCircleVerificationActive,
    hasPendingEmailOtp,
    handleAuthFailure,
    ensureDeviceId,
    postW3sAction,
    storeLoginConfig,
  });

  const logout = useCallback(() => {
    clearCircleOAuthState();
    clearStoredLoginConfig({ preserveGoogleCookies: true });
    clearPasskeyState();
    persistSession(null);
    setArcWallet(null);
    setAuthError(null);
    setAuthStatus(null);
    setHasPendingEmailOtp(false);
    setIsAuthenticating(false);
    setSession(null);
    setSepoliaWallet(null);
    setWallets([]);
  }, [clearPasskeyState, clearStoredLoginConfig, persistSession]);

  const primaryWallet = arcWallet ?? sepoliaWallet ?? wallets[0] ?? null;
  const shouldAllowAuthBeforeDeviceId = useMemo(
    () => isMobileOrStandaloneAuthRuntime(),
    [],
  );
  const isLoginRuntimeReady = shouldAllowAuthBeforeDeviceId
    ? ready
    : Boolean(deviceId);

  const value = useMemo<CircleWalletContextValue>(
    () => ({
      arcWallet,
      authMethod: session?.authMethod ?? null,
      authError,
      authStatus,
      authenticated: Boolean(session),
      closeLogin: () => setIsLoginOpen(false),
      createContractExecutionChallenge,
      createTransferChallenge,
      createTypedDataChallenge,
      ensureSessionReady: async () => {
        await ensureCircleSessionReady({
          reason: "manual",
          refreshWallets: true,
        });
      },
      executeChallenge,
      getWalletBalances,
      hasPendingEmailOtp,
      isAuthenticating,
      initializationPhase,
      login: () => setIsLoginOpen(true),
      loginMethodLabel:
        session?.authMethod === "google"
          ? "Google"
          : session?.authMethod === "email"
            ? "Email"
            : session?.authMethod === "passkey"
              ? "Passkey"
              : "Circle",
      logout,
      primaryWallet,
      ready,
      refreshWallets: async () => {
        await loadWallets();
      },
      requestEmailOtp,
      requestGoogleLogin,
      requestPasskeyLogin,
      requestPasskeyRegistration,
      sepoliaWallet,
      userEmail: session?.email ?? null,
      userToken:
        session && !isPasskeySession(session) ? session.userToken : null,
      verifyEmailOtp,
      wallets,
    }),
    [
      arcWallet,
      authError,
      authStatus,
      createContractExecutionChallenge,
      createTransferChallenge,
      createTypedDataChallenge,
      ensureCircleSessionReady,
      executeChallenge,
      getWalletBalances,
      hasPendingEmailOtp,
      isAuthenticating,
      initializationPhase,
      loadWallets,
      logout,
      primaryWallet,
      ready,
      requestEmailOtp,
      requestGoogleLogin,
      requestPasskeyLogin,
      requestPasskeyRegistration,
      sepoliaWallet,
      session,
      verifyEmailOtp,
      wallets,
    ],
  );

  return (
    <CircleWalletContext.Provider value={value}>
      {children}
      <LoginModal
        authError={authError}
        authStatus={authStatus}
        canUseGoogle={Boolean(CIRCLE_APP_ID && GOOGLE_CLIENT_ID)}
        canUsePasskey={PASSKEY_ENABLED}
        hasPendingEmailOtp={hasPendingEmailOtp}
        isSdkReady={isLoginRuntimeReady}
        isAuthenticating={isAuthenticating}
        isCircleVerificationActive={isCircleVerificationActive}
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onRequestEmailOtp={requestEmailOtp}
        onRequestGoogleLogin={requestGoogleLogin}
        onRequestPasskeyLogin={requestPasskeyLogin}
        onRequestPasskeyRegistration={requestPasskeyRegistration}
        onVerifyEmailOtp={verifyEmailOtp}
        passkeyUnavailableReason={passkeyUnavailableReason}
      />
    </CircleWalletContext.Provider>
  );
}

export function useCircleWallet() {
  const value = useContext(CircleWalletContext);

  if (!value) {
    throw new Error(
      "useCircleWallet must be used inside CircleWalletProvider.",
    );
  }

  return value;
}
