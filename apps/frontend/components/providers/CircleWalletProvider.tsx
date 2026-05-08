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
import { deleteCookie, getCookie, setCookie } from "cookies-next";
import { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";
import type { Address, Hex } from "viem";

import {
  clearStoredPasskeyCredential,
  createPasskeyRuntimeSet,
  getCirclePasskeyConfig,
  getPasskeySupportError,
  getPasskeyTokenBalances,
  loginWithPasskey,
  readStoredPasskeyCredential,
  readStoredPasskeyUsername,
  registerWithPasskey,
  sendPasskeyUserOperation,
  signPasskeyTypedData,
  storePasskeyCredential,
  storePasskeyUsername,
  type PasskeyChainRuntime,
  type PasskeyRuntimeSet,
} from "@/lib/circle-passkey";
import {
  ensureBackendWallet,
  initializeBackendWallets,
  syncBackendWallets,
} from "@/lib/backend-wallets";
import { buildBackendUrl, resolveBackendBaseUrl } from "@/lib/backend-api";

import { LoginModal } from "./circle/LoginModal";
import { usePasskeyAuth } from "./circle/usePasskeyAuth";
import { useGoogleAuth } from "./circle/useGoogleAuth";
import { useEmailAuth } from "./circle/useEmailAuth";
import { useWalletLoader } from "./circle/useWalletLoader";
import { useChallengeActions } from "./circle/useChallengeActions";
import { useSdkInitializer } from "./circle/useSdkInitializer";
import { useCircleMobileRecovery } from "./circle/useMobileRecovery";
import type {
  LoginMethod,
  W3SLoginMethod,
  CircleUserWallet,
  CircleW3SSession,
  CirclePasskeySession,
  CircleSession,
  CircleChallengeHandle,
  CirclePasskeyChallenge,
  CircleWalletTokenBalance,
  StoredLoginConfig,
  GoogleOAuthDiagnostics,
  W3SSdkInstance,
  W3SSdkModule,
  W3SLoginCompleteResult,
  CircleWalletContextValue,
} from "@/services/circle-auth.service";
import {
  CIRCLE_APP_ID,
  GOOGLE_CLIENT_ID,
  PASSKEY_ENABLED,
  PASSKEY_CONFIG,
  INVALID_DEVICE_ERROR_CODES,
  OAUTH_RECOVERY_ERROR_CODES,
  getGoogleOAuthErrorMessage,
  getErrorMessage,
  isRecord,
  isW3SLoginCompleteResult,
  isPasskeySession,
  createLocalChallengeId,
  extractChallengeId,
  normalizeCircleWalletTokenBalance,
  readStoredJson,
  writeStoredJson,
  removeStoredValue,
  readCircleOAuthBackup,
  getRestoredCircleAppId,
  buildGoogleLoginConfigs,
  readGoogleLoginConfigFromCookies,
  persistGoogleLoginCookies,
  restoreCircleOAuthStateFromCookies,
  clearGoogleLoginCookies,
  clearCircleOAuthState,
  clearCircleOAuthBackups,
  DEVICE_ID_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  LOGIN_CONFIG_STORAGE_KEY,
  SUPPORTED_WALLET_CHAINS,
  isHexValue,
  getGoogleOAuthDiagnostics,
} from "@/services/circle-auth.service";

export const CircleWalletContext =
  createContext<CircleWalletContextValue | null>(null);
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
  solanaWallet: null,
  savePasskeySolanaAddress: () => {},
  userEmail: null,
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
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [passkeyUnavailableReason, setPasskeyUnavailableReason] = useState<
    string | null
  >(null);
  const [ready, setReady] = useState(false);
  const [sepoliaWallet, setSepoliaWallet] = useState<CircleUserWallet | null>(
    null,
  );
  const [solanaWallet, setSolanaWallet] = useState<CircleUserWallet | null>(
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

    const nextDeviceId = await sdk.getDeviceId();

    if (!nextDeviceId) {
      throw new Error("Circle device ID is unavailable.");
    }

    setDeviceId(nextDeviceId);

    if (typeof window !== "undefined") {
      window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, nextDeviceId);
    }

    return nextDeviceId;
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
      // Passkey runtimeSet only contains EVM wallets (Arc + Sepolia).
      // Solana wallet is kept from the previous state if it was already loaded
      // via the backend; applyPasskeyRuntimeSet intentionally does NOT clear it.
      const nextSolana =
        nextWallets.find((wallet) => wallet.blockchain === "SOLANA-DEVNET") ??
        null;
      if (nextSolana) {
        setSolanaWallet(nextSolana);
      }
      // If nextSolana is null, we leave solanaWallet as-is (may be populated
      // from a prior syncBackendWallets call or a manual backend fetch).
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
  const PASSKEY_SOLANA_CACHE_KEY = "passkey_manual_solana_address";

  const savePasskeySolanaAddress = useCallback(
    (address: string) => {
      const syntheticWallet: import("@/services/circle-auth.service").CircleUserWallet = {
        id: "passkey-manual-solana",
        address,
        blockchain: "SOLANA-DEVNET",
        accountType: "EOA",
      };
      setSolanaWallet(syntheticWallet);
      writeStoredJson(PASSKEY_SOLANA_CACHE_KEY, { address, blockchain: "SOLANA-DEVNET" });
    },
    [],
  );

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

      // For passkey sessions, Circle AA wallets are EVM-only (no Solana).
      // Restore Solana address from localStorage — prefer the user's manually
      // saved address; fall back to an address cached from a prior W3S login.
      const manualSolana = readStoredJson<{ address: string }>(PASSKEY_SOLANA_CACHE_KEY);
      const w3sCachedSolana = readStoredJson<{ address: string; blockchain: string }>("solana_wallet_cache");
      const solanaAddress = manualSolana?.address || w3sCachedSolana?.address;
      if (solanaAddress) {
        setSolanaWallet({
          id: "passkey-manual-solana",
          address: solanaAddress,
          blockchain: "SOLANA-DEVNET",
          accountType: "EOA",
        } as CircleUserWallet);
      }
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
    loadWalletsEnsuringSolana,
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
    setSolanaWallet,
    setAuthError,
    setAuthStatus,
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
    setSession,
    ready,
    deviceId,
    ensureDeviceId,
  });

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
      setSolanaWallet(null);
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
        : sdkRef.current ?? (await reinitializeSdk());

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
    loadWalletsEnsuringSolana,
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
          await loadWalletsEnsuringSolana(activeSession as CircleSession);
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
          setSolanaWallet(null);
        }
      }
    }

    if (wallets.length === 0) {
      void hydrateWallets();
    }

    return () => {
      cancelled = true;
    };
  }, [
    clearPasskeyState,
    handleAuthFailure,
    loadWallets,
    loadWalletsEnsuringSolana,
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
    setSolanaWallet(null);
    setWallets([]);
  }, [clearPasskeyState, clearStoredLoginConfig, persistSession]);

  const primaryWallet =
    arcWallet ?? sepoliaWallet ?? solanaWallet ?? wallets[0] ?? null;

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
      savePasskeySolanaAddress,
      sepoliaWallet,
      solanaWallet,
      userEmail: session?.email ?? null,
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
      loadWallets,
      logout,
      primaryWallet,
      ready,
      requestEmailOtp,
      requestGoogleLogin,
      requestPasskeyLogin,
      requestPasskeyRegistration,
      savePasskeySolanaAddress,
      sepoliaWallet,
      solanaWallet,
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
        isDeviceReady={Boolean(deviceId)}
        isAuthenticating={isAuthenticating}
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
