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

function buildW3sUserActionParams(
  payload: Record<string, unknown>,
  userToken: string,
) {
  const normalized: Record<string, unknown> = {
    ...payload,
    userToken,
  };

  if (typeof normalized.walletId === "string") {
    normalized.walletId = normalized.walletId.trim();
  }

  if (typeof normalized.contractAddress === "string") {
    normalized.contractAddress = normalized.contractAddress
      .trim()
      .toLowerCase();
  }

  if (typeof normalized.destinationAddress === "string") {
    const destAddr = normalized.destinationAddress.trim();
    normalized.destinationAddress = destAddr.startsWith("0x") ? destAddr.toLowerCase() : destAddr;
  }

  if (Array.isArray(normalized.amounts)) {
    normalized.amounts = normalized.amounts.map((amount) => String(amount));
  }

  if (typeof normalized.amount === "number") {
    normalized.amount = String(normalized.amount);
  }

  if (typeof normalized.blockchain === "string") {
    normalized.blockchain = normalized.blockchain
      .trim()
      .toUpperCase()
      .replace(/_/g, "-");
  }

  if (typeof normalized.sourceChain === "string") {
    normalized.sourceChain = normalized.sourceChain
      .trim()
      .toUpperCase()
      .replace(/_/g, "-");
  }

  if (typeof normalized.destinationChain === "string") {
    normalized.destinationChain = normalized.destinationChain
      .trim()
      .toUpperCase()
      .replace(/_/g, "-");
  }

  return normalized;
}

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

  const initializePasskeyWallets

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
    },
      return runtimeSet;
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

  const handleAuthFailureRef = useRef<((error: unknown) => void) | null>(null);
  const initializeAndLoadWalletsRef = useRef<
    ((authSession: CircleW3SSession) => Promise<void>) | null
  >(null);
  const ensuredSolanaByUserTokenRef = useRef(new Set<string>());
  const persistSessionRef = useRef<
    ((nextSession: CircleSession | null) => void) | null
  >(null);

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
    [initializePasskeyWallets, resetPasskeyRuntimeState, session],
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
            reject(new Error(getErrorMessage(error)));
            return;
          }

          resolve(result);
        });
      });
    },
    [executePasskeyChallenge],
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
    [executeChallengeForSession, loadWallets],
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
      clearStoredLoginConfig,
      executeChallengeForSession,
      loadWalletsEnsuringSolana,
    ],
  );

  const executeChallenge = useCallback(
    async (challengeId: string) => {
      if (!session) {
        throw new Error("Circle session is not available.");
      }

      return executeChallengeForSession(challengeId, session);
    },
    [executeChallengeForSession, session],
  );

  const createContractExecutionChallenge = useCallback(
    async (payload: Record<string, unknown>) => {
      if (isPasskeySession(session)) {
        const walletId =
          typeof payload.walletId === "string" && payload.walletId
            ? payload.walletId
            : null;
        const contractAddress = isHexValue(payload.contractAddress, 20)
          ? (payload.contractAddress as Address)
          : null;
        const callData = isHexValue(payload.callData)
          ? (payload.callData as Hex)
          : null;

        if (!walletId || !contractAddress || !callData) {
          throw new Error(
            "Passkey execution payload is missing the target wallet, contract, or calldata.",
          );
        }

        const challengeId = createLocalChallengeId("passkey-contract");

        passkeyChallengeStoreRef.current.set(challengeId, {
          callData,
          contractAddress,
          kind: "contract",
          referenceId:
            typeof payload.refId === "string" && payload.refId
              ? payload.refId
              : null,
          walletId,
        });

        return {
          challengeId,
          raw: {
            challengeId,
            transactionId:
              typeof payload.refId === "string" && payload.refId
                ? payload.refId
                : null,
            walletId,
          },
        };
      }

      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await postW3sAction("createContractExecutionChallenge", {
        ...buildW3sUserActionParams(payload, session.userToken),
      });

      if (!isRecord(response)) {
        throw new Error("Circle did not return a valid challenge response.");
      }

      const challengeId = extractChallengeId(response);

      if (!challengeId) {
        throw new Error("Circle did not return a challenge identifier.");
      }

      return {
        challengeId,
        raw: response,
      };
    },
    [postW3sAction, session],
  );

  const createTransferChallenge = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await postW3sAction("createTransferChallenge", {
        ...buildW3sUserActionParams(payload, session.userToken),
      });

      if (!isRecord(response)) {
        throw new Error("Circle did not return a valid challenge response.");
      }

      const challengeId = extractChallengeId(response);

      if (!challengeId) {
        throw new Error("Circle did not return a challenge identifier.");
      }

      return {
        challengeId,
        raw: response,
      };
    },
    [postW3sAction, session],
  );

  const createTypedDataChallenge = useCallback(
    async (payload: Record<string, unknown>) => {
      if (isPasskeySession(session)) {
        const walletId =
          typeof payload.walletId === "string" && payload.walletId
            ? payload.walletId
            : null;
        const typedDataJson =
          typeof payload.data === "string" && payload.data
            ? payload.data
            : null;

        if (!walletId || !typedDataJson) {
          throw new Error(
            "Passkey typed-data payload is missing the target wallet or payload.",
          );
        }

        const challengeId = createLocalChallengeId("passkey-typed-data");

        passkeyChallengeStoreRef.current.set(challengeId, {
          kind: "typed-data",
          typedDataJson,
          walletId,
        });

        return {
          challengeId,
          raw: {
            challengeId,
            walletId,
          },
        };
      }

      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await postW3sAction("createTypedDataChallenge", {
        ...buildW3sUserActionParams(payload, session.userToken),
      });

      if (!isRecord(response)) {
        throw new Error(
          "Circle did not return a valid sign challenge response.",
        );
      }

      const challengeId = extractChallengeId(response);

      if (!challengeId) {
        throw new Error("Circle did not return a sign challenge identifier.");
      }

      return {
        challengeId,
        raw: response,
      };
    },
    [postW3sAction, session],
  );

  const getWalletBalances = useCallback(
    async (walletId: string): Promise<CircleWalletTokenBalance[]> => {
      if (isPasskeySession(session)) {
        const runtime = passkeyRuntimeByWalletIdRef.current.get(walletId);

        if (!runtime) {
          throw new Error("Passkey wallet session is not ready.");
        }

        const _passkeyBalances = await getPasskeyTokenBalances(runtime);
        return _passkeyBalances.map((pb) => ({
          ...pb,
          tokenId: null,
        })) as CircleWalletTokenBalance[];
      }

      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await postW3sAction("getWalletBalances", {
        userToken: session.userToken,
        walletId,
      });

      if (!isRecord(response) || !Array.isArray(response.tokenBalances)) {
        return [];
      }

      return response.tokenBalances
        .map((balance) => normalizeCircleWalletTokenBalance(balance))
        .filter(
          (balance): balance is CircleWalletTokenBalance => balance !== null,
        );
    },
    [postW3sAction, session],
  );

  useEffect(() => {
    const storedSession = readStoredJson<CircleSession>(SESSION_STORAGE_KEY);
    const storedLoginConfig = readStoredJson<StoredLoginConfig>(
      LOGIN_CONFIG_STORAGE_KEY,
    );

    if (storedSession) {
      setSession(storedSession);
    }

    if (storedLoginConfig) {
      loginConfigRef.current = storedLoginConfig;
      setHasPendingEmailOtp(storedLoginConfig.loginMethod === "email");
    }
  }, []);

  useEffect(() => {
    setPasskeyUnavailableReason(getPasskeySupportError(PASSKEY_CONFIG));
  }, []);

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
    let cancelled = false;

    async function initializeSdk() {
      try {
        console.log(
          "[CircleWalletProvider] SDK init — URL:",
          window.location.href,
        );
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

          if (!cancelled) {
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
          if (cancelled) {
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

        if (!cancelled) {
          setReady(true);
          setAuthStatus(null);
        }
      } catch (error) {
        if (!cancelled) {
          setReady(true);
          handleAuthFailureRef.current?.(error);
        }
      }
    }

    void initializeSdk();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || deviceId) {
      return;
    }

    let cancelled = false;

    async function fetchDeviceId() {
      try {
        await ensureDeviceId();

        if (!cancelled) {
          setAuthError((current) =>
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
  }, [deviceId, ensureDeviceId, handleAuthFailure, ready]);

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
    loadWallets,
    loadWalletsEnsuringSolana,
    persistSession,
    session,
    wallets.length,
  ]);

  const requestPasskeyRegistration = useCallback(
    async (username: string) => {
      const normalizedUsername = username.trim();
      const supportError = getPasskeySupportError(PASSKEY_CONFIG);

      if (supportError) {
        setAuthError(supportError);
        return;
      }

      if (!normalizedUsername) {
        setAuthError("Enter a username before creating a passkey.");
        return;
      }

      if (authRequestInFlightRef.current) {
        return;
      }

      authRequestInFlightRef.current = true;
      setAuthError(null);
      setAuthStatus("Creating your Circle passkey...");
      setIsAuthenticating(true);

      try {
        resetPasskeyRuntimeState();

        const result = await registerWithPasskey(
          normalizedUsername,
          PASSKEY_CONFIG,
        );

        setAuthStatus("Preparing your Circle passkey wallet...");
        await finalizePasskeyAuthentication({
          credential: result.credential,
          username: normalizedUsername,
        });
      } catch (error) {
        resetPasskeyRuntimeState();
        handleAuthFailure(error);
      } finally {
        authRequestInFlightRef.current = false;
        setIsAuthenticating(false);
      }
    },
    [
      finalizePasskeyAuthentication,
      handleAuthFailure,
      resetPasskeyRuntimeState,
    ],
  );

  const requestPasskeyLogin = useCallback(async () => {
    const supportError = getPasskeySupportError(PASSKEY_CONFIG);

    if (supportError) {
      setAuthError(supportError);
      return;
    }

    if (authRequestInFlightRef.current) {
      return;
    }

    authRequestInFlightRef.current = true;
    setAuthError(null);
    setAuthStatus("Opening your passkey prompt...");
    setIsAuthenticating(true);

    try {
      resetPasskeyRuntimeState();

      const credential = await loginWithPasskey(PASSKEY_CONFIG);

      setAuthStatus("Restoring your Circle passkey wallet...");
      await finalizePasskeyAuthentication({
        credential,
        username: readStoredPasskeyUsername(),
      });
    } catch (error) {
      resetPasskeyRuntimeState();
      handleAuthFailure(error);
    } finally {
      authRequestInFlightRef.current = false;
      setIsAuthenticating(false);
    }
  }, [
    finalizePasskeyAuthentication,
    handleAuthFailure,
    resetPasskeyRuntimeState,
  ]);

  const requestGoogleLogin = useCallback(async () => {
    if (!CIRCLE_APP_ID) {
      setAuthError(
        "NEXT_PUBLIC_CIRCLE_APP_ID is missing. Configure Circle Wallets before signing in.",
      );
      return;
    }

    if (!GOOGLE_CLIENT_ID) {
      setAuthError(
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID is missing. Add your Circle-linked Google client ID first.",
      );
      return;
    }

    const sdk = sdkRef.current;

    if (!sdk) {
      setAuthError("Circle Web SDK is not ready yet.");
      return;
    }

    if (authRequestInFlightRef.current) {
      return;
    }

    authRequestInFlightRef.current = true;

    setAuthError(null);
    setAuthStatus("Preparing Google sign-in...");
    setIsAuthenticating(true);

    try {
      googleOAuthDiagnosticsRef.current = null;
      clearCircleOAuthState();
      clearStoredLoginConfig({ preserveGoogleCookies: true });

      const cachedGoogleLoginConfig = readGoogleLoginConfigFromCookies();
      let loginConfigs: Record<string, unknown>;

      if (cachedGoogleLoginConfig) {
        loginConfigs = cachedGoogleLoginConfig.loginConfigs;
        setAuthStatus("Reusing Circle device registration...");
      } else {
        const resolvedDeviceId = await ensureDeviceId();

        setAuthStatus("Creating Circle device token...");

        const payload = (await postW3sAction("createDeviceToken", {
          deviceId: resolvedDeviceId,
        })) as {
          deviceEncryptionKey: string;
          deviceToken: string;
        };

        if (!payload.deviceEncryptionKey || !payload.deviceToken) {
          throw new Error(
            "Circle did not return device credentials. " +
              "Check that CIRCLE_API_KEY is set on the backend.",
          );
        }

        loginConfigs = buildGoogleLoginConfigs({
          deviceEncryptionKey: payload.deviceEncryptionKey,
          deviceToken: payload.deviceToken,
          googleClientId: GOOGLE_CLIENT_ID,
        });

        persistGoogleLoginCookies({
          appId: CIRCLE_APP_ID,
          deviceEncryptionKey: payload.deviceEncryptionKey,
          deviceToken: payload.deviceToken,
          googleClientId: GOOGLE_CLIENT_ID,
        });
      }

      storeLoginConfig({
        loginMethod: "google",
        loginConfigs,
      });

      sdk.updateConfigs({
        appSettings: { appId: CIRCLE_APP_ID },
        loginConfigs,
      });

      setAuthStatus("Redirecting to Google...");

      // Let the SDK handle OAuth URL generation, state/nonce persistence,
      // and the redirect. The SDK's saveOAuthInfo writes 'socialLoginProvider',
      // 'state', and 'nonce' to localStorage, and its checkSocialLoginState
      // reads them back on return. Manual management causes mismatches.
      await sdk.performLogin(SocialLoginProvider.GOOGLE);
    } catch (error) {
      setIsAuthenticating(false);
      handleAuthFailure(error);
    }
  }, [
    clearStoredLoginConfig,
    ensureDeviceId,
    handleAuthFailure,
    postW3sAction,
    storeLoginConfig,
  ]);

  const requestEmailOtp = useCallback(
    async (email: string) => {
      if (!CIRCLE_APP_ID) {
        setAuthError(
          "NEXT_PUBLIC_CIRCLE_APP_ID is missing. Configure Circle Wallets before signing in.",
        );
        return;
      }

      const normalizedEmail = email.trim();

      if (!normalizedEmail) {
        setAuthError("Enter your email address first.");
        return;
      }

      const sdk = sdkRef.current;

      if (!sdk) {
        setAuthError("Circle Web SDK is not ready yet.");
        return;
      }

      if (authRequestInFlightRef.current) {
        return;
      }

      authRequestInFlightRef.current = true;

      setAuthError(null);
      setAuthStatus("Requesting Circle email OTP...");
      setIsAuthenticating(true);

      try {
        const resolvedDeviceId = await ensureDeviceId();
        const payload = (await postW3sAction("requestEmailOtp", {
          deviceId: resolvedDeviceId,
          email: normalizedEmail,
        })) as {
          deviceEncryptionKey: string;
          deviceToken: string;
          otpToken: string;
        };

        const loginConfigs = {
          deviceToken: payload.deviceToken,
          deviceEncryptionKey: payload.deviceEncryptionKey,
          otpToken: payload.otpToken,
          email: {
            email: normalizedEmail,
          },
        };

        sdk.updateConfigs({
          appSettings: { appId: CIRCLE_APP_ID },
          loginConfigs,
        });

        storeLoginConfig({
          loginMethod: "email",
          loginConfigs,
          email: normalizedEmail,
        });

        setAuthStatus(
          "OTP sent. Open the Circle OTP window to verify your email.",
        );
      } catch (error) {
        handleAuthFailure(error);
      } finally {
        authRequestInFlightRef.current = false;
        setIsAuthenticating(false);
      }
    },
    [ensureDeviceId, handleAuthFailure, postW3sAction, storeLoginConfig],
  );

  const verifyEmailOtp = useCallback(() => {
    const sdk = sdkRef.current;

    if (!sdk) {
      setAuthError("Circle Web SDK is not ready yet.");
      return;
    }

    if (!hasPendingEmailOtp) {
      setAuthError("Request an email OTP before verifying it.");
      return;
    }

    setAuthError(null);
    setAuthStatus("Opening Circle email verification window...");
    setIsAuthenticating(true);
    sdk.verifyOtp();
  }, [hasPendingEmailOtp]);

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
      sepoliaWallet,
      solanaWallet,
      userEmail: session?.email ?? null,
      verifyEmailOtp,
      wallets,
      savePasskeySolanaAddress,
      sepoliaWallet,
      solanaWallet,
      userEmail: session?.email ?? null,
      verifyEmailOtp,
      wallets,
      requestPasskeyLogin,
      requestPasskeyRegistration,
      savePasskeySolanaAddress,
      sepoliaWallet,
      solanaWallet,
      session,
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
