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
import { Fingerprint, LogIn, Mail, ShieldCheck, Wallet } from "lucide-react";
import type { Address, Hex } from "viem";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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

export type LoginMethod = "google" | "email" | "passkey";

export type W3SLoginMethod = Extract<LoginMethod, "google" | "email">;

export type CircleUserWallet = {
  id: string;
  address: string;
  blockchain: string;
  accountType?: string;
  [key: string]: unknown;
};

export type CircleW3SSession = {
  authMethod: W3SLoginMethod;
  email: string | null;
  encryptionKey: string;
  refreshToken?: string;
  userToken: string;
};

export type CirclePasskeySession = {
  authMethod: "passkey";
  email: null;
  passkeyUsername: string | null;
};

export type CircleSession = CircleW3SSession | CirclePasskeySession;

export type CircleChallengeHandle = {
  challengeId: string;
  raw: Record<string, unknown>;
};

export type CirclePasskeyChallenge =
  | {
      callData: Hex;
      contractAddress: Address;
      kind: "contract";
      referenceId: string | null;
      walletId: string;
    }
  | {
      kind: "typed-data";
      typedDataJson: string;
      walletId: string;
    };

export type CircleWalletTokenBalance = {
  amount: string;
  raw: Record<string, unknown>;
  symbol: string | null;
  tokenAddress: string | null;
  tokenId: string | null;
  updatedAt: string | null;
};

export type StoredLoginConfig = {
  email?: string | null;
  loginConfigs: Record<string, unknown>;
  loginMethod: W3SLoginMethod;
};

export type GoogleOAuthDiagnostics = {
  audience: string | null;
  clientIdMatches: boolean | null;
  configuredClientId: string | null;
  hasDeviceEncryptionKey: boolean;
  hasDeviceToken: boolean;
  nonceMatches: boolean | null;
  provider: string | null;
  redirectUri: string | null;
  stateMatches: boolean | null;
};

export type W3SSdkInstance = {
  execute: (
    challengeId: string,
    callback: (error?: unknown, result?: unknown) => void
  ) => void;
  getDeviceId: () => Promise<string>;
  performLogin: (provider: unknown) => Promise<void>;
  setAuthentication: (auth: {
    encryptionKey: string;
    userToken: string;
  }) => void;
  updateConfigs: (config: Record<string, unknown>) => void;
  verifyOtp: () => void;
};

export type W3SSdkModule = {
  W3SSdk?: new (
    config: Record<string, unknown>,
    onLoginComplete: (error: unknown, result: unknown) => void
  ) => W3SSdkInstance;
};

export type W3SLoginCompleteResult = {
  encryptionKey: string;
  refreshToken?: string;
  userToken: string;
};

export type CircleWalletContextValue = {
  arcWallet: CircleUserWallet | null;
  authMethod: LoginMethod | null;
  authError: string | null;
  authStatus: string | null;
  authenticated: boolean;
  closeLogin: () => void;
  createContractExecutionChallenge: (
    payload: Record<string, unknown>
  ) => Promise<CircleChallengeHandle>;
  createTransferChallenge: (
    payload: Record<string, unknown>
  ) => Promise<CircleChallengeHandle>;
  createTypedDataChallenge: (
    payload: Record<string, unknown>
  ) => Promise<CircleChallengeHandle>;
  executeChallenge: (challengeId: string) => Promise<unknown>;
  getWalletBalances: (walletId: string) => Promise<CircleWalletTokenBalance[]>;
  hasPendingEmailOtp: boolean;
  isAuthenticating: boolean;
  login: () => void;
  loginMethodLabel: string;
  logout: () => void;
  primaryWallet: CircleUserWallet | null;
  ready: boolean;
  refreshWallets: () => Promise<void>;
  requestEmailOtp: (email: string) => Promise<void>;
  requestGoogleLogin: () => Promise<void>;
  requestPasskeyLogin: () => Promise<void>;
  requestPasskeyRegistration: (username: string) => Promise<void>;
  sepoliaWallet: CircleUserWallet | null;
  solanaWallet: CircleUserWallet | null;
  /** Save a Solana address manually (for passkey users who have no Circle Solana wallet). */
  savePasskeySolanaAddress: (address: string) => void;
  userEmail: string | null;
  verifyEmailOtp: () => void;
  wallets: CircleUserWallet[];
};

export const CIRCLE_APP_ID = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? "";
export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
// Passkey is disabled when the env var is empty — controls both UI and logic.
export const PASSKEY_ENABLED = Boolean(process.env.NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_KEY?.trim());
export const PASSKEY_CONFIG = getCirclePasskeyConfig();
export const APP_ID_COOKIE_KEY = "wizpay.circle.app-id";
export const DEVICE_ID_STORAGE_KEY = "wizpay.circle.device-id";
export const DEVICE_ENCRYPTION_KEY_COOKIE_KEY = "deviceEncryptionKey";
export const DEVICE_TOKEN_COOKIE_KEY = "deviceToken";
export const GOOGLE_CLIENT_ID_COOKIE_KEY = "google.clientId";
export const LOGIN_CONFIG_STORAGE_KEY = "wizpay.circle.login-config";
export const LOGIN_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax" as const,
};
export const OAUTH_NONCE_COOKIE_KEY = "wizpay.circle.oauth.nonce";
export const OAUTH_NONCE_FALLBACK_STORAGE_KEY = "wizpay.circle.oauth.backup.nonce";
export const OAUTH_PROVIDER_COOKIE_KEY = "wizpay.circle.oauth.provider";
export const OAUTH_PROVIDER_FALLBACK_STORAGE_KEY = "wizpay.circle.oauth.backup.provider";
export const OAUTH_STATE_COOKIE_KEY = "wizpay.circle.oauth.state";
export const OAUTH_STATE_FALLBACK_STORAGE_KEY = "wizpay.circle.oauth.backup.state";
export const SESSION_STORAGE_KEY = "wizpay.circle.session";
export const SOCIAL_LOGIN_PROVIDER_STORAGE_KEY = "socialLoginProvider";
export const SOCIAL_LOGIN_STATE_STORAGE_KEY = "state";
export const SOCIAL_LOGIN_NONCE_STORAGE_KEY = "nonce";
export const SUPPORTED_WALLET_CHAINS = new Set([
  "ARC-TESTNET",
  "ETH-SEPOLIA",
  "SOLANA-DEVNET",
]);
export const INVALID_DEVICE_ERROR_CODES = new Set([155113, 155137, 155143, 155144, 155145]);
export const OAUTH_RECOVERY_ERROR_CODES = new Set([155114, 155140]);

export const CircleWalletContext = createContext<CircleWalletContextValue | null>(null);

export function getGoogleOAuthErrorMessage(diagnostics: GoogleOAuthDiagnostics | null) {
  if (!diagnostics) {
    return "Circle failed to validate the Google OAuth response. In Circle's Web SDK this can mean the Google Client ID does not match, the OAuth redirect URI is not allowed for http://localhost:3000, or the saved OAuth state/nonce from a previous redirect became stale. Retry after the app clears the old OAuth session.";
  }

  if (diagnostics.provider?.toUpperCase() !== "GOOGLE") {
    return "Circle returned from Google, but the saved OAuth provider marker was missing from browser storage when the callback loaded. This browser likely lost the pre-login OAuth session before Circle could verify it.";
  }

  if (diagnostics.stateMatches === false) {
    return "Circle rejected the Google redirect because the OAuth state returned by Google no longer matches the state saved in this browser. This usually means the pre-login browser state was replaced before the redirect completed.";
  }

  if (diagnostics.nonceMatches === false) {
    return "Circle rejected the Google redirect because the ID token nonce returned by Google does not match the nonce saved before redirect. That means this browser no longer has the same OAuth session that started the login.";
  }

  if (!diagnostics.hasDeviceToken || !diagnostics.hasDeviceEncryptionKey) {
    return "Google redirect returned correctly, but the stored Circle device verification config was missing when the app came back from Google. Retry once so the app can recreate the Circle login config before redirecting again.";
  }

  if (diagnostics.clientIdMatches === false) {
    const audienceLabel = diagnostics.audience ?? "a different Google OAuth client";
    const configuredLabel =
      diagnostics.configuredClientId ?? "the configured NEXT_PUBLIC_GOOGLE_CLIENT_ID";

    return `Google returned an ID token for ${audienceLabel}, but this app is configured for ${configuredLabel}.`;
  }

  return "Google redirect passed the browser-side state, nonce, and client ID checks, but Circle still rejected the token. That usually means the Google client ID is not enabled on the same Circle User-Controlled Wallet app as NEXT_PUBLIC_CIRCLE_APP_ID in Circle Console.";
}

export function getErrorMessage(
  error: unknown,
  googleOAuthDiagnostics: GoogleOAuthDiagnostics | null = null
) {
  const directMessage =
    getNestedString(error, ["message"]) ??
    getNestedString(error, ["error", "message"]) ??
    getNestedString(error, ["data", "message"]);
  const directCode =
    (isRecord(error) && typeof error.code === "number" ? error.code : null) ??
    (isRecord(error) && isRecord(error.error) && typeof error.error.code === "number"
      ? error.error.code
      : null) ??
    (isRecord(error) && isRecord(error.data) && typeof error.data.code === "number"
      ? error.data.code
      : null);

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (directCode === 155114) {
    return "Circle app ID does not match this wallet app. Verify NEXT_PUBLIC_CIRCLE_APP_ID comes from the same User-Controlled Wallet app in Circle Console.";
  }

  if (directCode === 155140) {
    return getGoogleOAuthErrorMessage(googleOAuthDiagnostics);
  }

  if (directCode === 155706) {
    return "Circle verification iframe did not respond. Refresh the page, allow third-party cookies for localhost and pw-auth.circle.com, then retry.";
  }

  if (INVALID_DEVICE_ERROR_CODES.has(directCode ?? -1)) {
    return "Circle rejected the cached device session. Refreshing the device registration and retrying should fix it.";
  }

  if (directMessage) {
    return directCode ? `Circle error ${directCode}: ${directMessage}` : directMessage;
  }

  return "Circle wallet request failed.";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isW3SLoginCompleteResult(
  value: unknown
): value is W3SLoginCompleteResult {
  return (
    isRecord(value) &&
    typeof value.encryptionKey === "string" &&
    typeof value.userToken === "string" &&
    (typeof value.refreshToken === "string" ||
      typeof value.refreshToken === "undefined")
  );
}

export function isPasskeySession(
  value: CircleSession | null | undefined
): value is CirclePasskeySession {
  return value?.authMethod === "passkey";
}

export function isHexValue(
  value: unknown,
  expectedBytes?: number
): value is `0x${string}` {
  if (typeof value !== "string") {
    return false;
  }

  const sizePattern = expectedBytes ? `{${expectedBytes * 2}}` : "*";
  return new RegExp(`^0x[a-fA-F0-9]${sizePattern}$`).test(value);
}

export function createLocalChallengeId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}:${crypto.randomUUID()}`;
  }

  return `${prefix}:${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`;
}

export function getNestedString(source: unknown, path: string[]) {
  let current: unknown = source;

  for (const key of path) {
    if (!isRecord(current) || typeof current[key] === "undefined") {
      return null;
    }

    current = current[key];
  }

  return typeof current === "string" && current ? current : null;
}

export function decodeJwtPayload(token: string | null) {
  if (typeof window === "undefined" || !token) {
    return null;
  }

  const [, payloadSegment] = token.split(".");

  if (!payloadSegment) {
    return null;
  }

  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );

    return JSON.parse(window.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getGoogleAudienceInfo(
  audience: unknown,
  configuredClientId: string | null
) {
  if (typeof audience === "string") {
    return {
      audience,
      matches: configuredClientId ? audience === configuredClientId : null,
    };
  }

  if (Array.isArray(audience)) {
    const stringAudiences = audience.filter(
      (value): value is string => typeof value === "string" && Boolean(value)
    );

    return {
      audience: stringAudiences[0] ?? null,
      matches: configuredClientId ? stringAudiences.includes(configuredClientId) : null,
    };
  }

  return {
    audience: null,
    matches: null,
  };
}

export function getGoogleOAuthDiagnostics(
  storedLoginConfig: StoredLoginConfig | null
): GoogleOAuthDiagnostics | null {
  if (typeof window === "undefined" || !window.location.hash.includes("id_token=")) {
    return null;
  }

  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const tokenPayload = decodeJwtPayload(hashParams.get("id_token"));
  const loginConfigs = isRecord(storedLoginConfig?.loginConfigs)
    ? storedLoginConfig.loginConfigs
    : null;
  const googleConfig = loginConfigs && isRecord(loginConfigs.google) ? loginConfigs.google : null;
  const configuredClientId =
    typeof googleConfig?.clientId === "string" && googleConfig.clientId
      ? googleConfig.clientId
      : GOOGLE_CLIENT_ID || null;
  const { audience, matches } = getGoogleAudienceInfo(
    tokenPayload?.aud,
    configuredClientId
  );
  const oauthBackup = readCircleOAuthBackup();
  const inferredProvider =
    oauthBackup.provider ||
    (window.location.hash.includes("id_token=") && configuredClientId ? SocialLoginProvider.GOOGLE : null);
  const returnedState = hashParams.get("state");
  const storedState =
    readStorageString(window.localStorage, SOCIAL_LOGIN_STATE_STORAGE_KEY) ||
    oauthBackup.state ||
    null;
  const returnedNonce =
    tokenPayload && typeof tokenPayload.nonce === "string" ? tokenPayload.nonce : null;
  const storedNonce =
    readStorageString(window.localStorage, SOCIAL_LOGIN_NONCE_STORAGE_KEY) ||
    oauthBackup.nonce ||
    null;

  return {
    audience,
    clientIdMatches: matches,
    configuredClientId,
    hasDeviceEncryptionKey:
      typeof loginConfigs?.deviceEncryptionKey === "string" &&
      Boolean(loginConfigs.deviceEncryptionKey),
    hasDeviceToken:
      typeof loginConfigs?.deviceToken === "string" && Boolean(loginConfigs.deviceToken),
    nonceMatches:
      storedNonce && returnedNonce
        ? storedNonce === returnedNonce
        : storedNonce || returnedNonce
          ? false
          : null,
    provider:
      readStorageString(window.localStorage, SOCIAL_LOGIN_PROVIDER_STORAGE_KEY) ||
      inferredProvider ||
      null,
    redirectUri:
      typeof googleConfig?.redirectUri === "string" && googleConfig.redirectUri
        ? googleConfig.redirectUri
        : window.location.origin,
    stateMatches:
      storedState && returnedState
        ? storedState === returnedState
        : storedState || returnedState
          ? false
          : null,
  };
}

export function extractChallengeId(payload: Record<string, unknown>) {
  return (
    getNestedString(payload, ["challengeId"]) ??
    getNestedString(payload, ["challenge", "id"]) ??
    getNestedString(payload, ["challenge", "challengeId"]) ??
    getNestedString(payload, ["data", "challengeId"]) ??
    getNestedString(payload, ["data", "challenge", "id"])
  );
}

export function normalizeCircleWalletTokenBalance(
  payload: unknown
): CircleWalletTokenBalance | null {
  const record = isRecord(payload) ? payload : null;

  if (!record || typeof record.amount !== "string" || !record.amount) {
    return null;
  }

  const token = isRecord(record.token) ? record.token : null;

  return {
    amount: record.amount,
    raw: record,
    symbol:
      typeof token?.symbol === "string" && token.symbol ? token.symbol : null,
    tokenAddress:
      typeof token?.tokenAddress === "string" && token.tokenAddress
        ? token.tokenAddress
        : null,
    tokenId: typeof token?.id === "string" && token.id ? token.id : null,
    updatedAt:
      typeof record.updateDate === "string" && record.updateDate
        ? record.updateDate
        : typeof record.updatedAt === "string" && record.updatedAt
          ? record.updatedAt
          : null,
  };
}

export function readStoredJson<T>(key: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const rawValue = window.localStorage.getItem(key);

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as T;
  } catch {
    return null;
  }
}

export function writeStoredJson(key: string, value: unknown) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

export function removeStoredValue(key: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(key);
}

export function readStorageString(storage: Storage | undefined, key: string) {
  try {
    const value = storage?.getItem(key);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export function writeStorageValue(storage: Storage | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Ignore storage write failures and continue with other fallbacks.
  }
}

export function removeStorageValue(storage: Storage | undefined, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function readCookieString(key: string) {
  if (typeof window === "undefined") {
    return "";
  }

  const value = getCookie(key);

  if (typeof value === "string") {
    return value;
  }

  return value ? String(value) : "";
}

export function readCircleOAuthBackup() {
  if (typeof window === "undefined") {
    return {
      nonce: "",
      provider: "",
      state: "",
    };
  }

  return {
    nonce:
      readStorageString(window.sessionStorage, OAUTH_NONCE_FALLBACK_STORAGE_KEY) ||
      readStorageString(window.localStorage, OAUTH_NONCE_FALLBACK_STORAGE_KEY) ||
      readCookieString(OAUTH_NONCE_COOKIE_KEY),
    provider:
      readStorageString(window.sessionStorage, OAUTH_PROVIDER_FALLBACK_STORAGE_KEY) ||
      readStorageString(window.localStorage, OAUTH_PROVIDER_FALLBACK_STORAGE_KEY) ||
      readCookieString(OAUTH_PROVIDER_COOKIE_KEY),
    state:
      readStorageString(window.sessionStorage, OAUTH_STATE_FALLBACK_STORAGE_KEY) ||
      readStorageString(window.localStorage, OAUTH_STATE_FALLBACK_STORAGE_KEY) ||
      readCookieString(OAUTH_STATE_COOKIE_KEY),
  };
}

export function getRestoredCircleAppId() {
  return readCookieString(APP_ID_COOKIE_KEY) || CIRCLE_APP_ID;
}

export function buildGoogleLoginConfigs({
  deviceEncryptionKey,
  deviceToken,
  googleClientId,
}: {
  deviceEncryptionKey: string;
  deviceToken: string;
  googleClientId: string;
}) {
  return {
    deviceToken,
    deviceEncryptionKey,
    google: {
      clientId: googleClientId,
      redirectUri: typeof window !== "undefined" ? window.location.origin : "",
      selectAccountPrompt: true,
    },
  };
}

export function createOAuthRedirectValue() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function buildGoogleOAuthRedirectUrl({
  clientId,
  nonce,
  redirectUri,
  selectAccountPrompt,
  state,
}: {
  clientId: string;
  nonce: string;
  redirectUri: string;
  selectAccountPrompt: boolean;
  state: string;
}) {
  const scope = encodeURIComponent(
    "openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email"
  );
  const responseType = encodeURIComponent("id_token token");

  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=${scope}&state=${state}&response_type=${responseType}&nonce=${nonce}&prompt=${
    selectAccountPrompt ? "select_account" : "none"
  }`;
}

export function readGoogleLoginConfigFromCookies(): StoredLoginConfig | null {
  const googleClientId = readCookieString(GOOGLE_CLIENT_ID_COOKIE_KEY) || GOOGLE_CLIENT_ID;
  const deviceToken = readCookieString(DEVICE_TOKEN_COOKIE_KEY);
  const deviceEncryptionKey = readCookieString(DEVICE_ENCRYPTION_KEY_COOKIE_KEY);

  if (!googleClientId || !deviceToken || !deviceEncryptionKey) {
    return null;
  }

  return {
    loginMethod: "google",
    loginConfigs: buildGoogleLoginConfigs({
      deviceEncryptionKey,
      deviceToken,
      googleClientId,
    }),
  };
}

export function persistGoogleLoginCookies({
  appId,
  deviceEncryptionKey,
  deviceToken,
  googleClientId,
}: {
  appId: string;
  deviceEncryptionKey: string;
  deviceToken: string;
  googleClientId: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  setCookie(APP_ID_COOKIE_KEY, appId, LOGIN_COOKIE_OPTIONS);
  setCookie(GOOGLE_CLIENT_ID_COOKIE_KEY, googleClientId, LOGIN_COOKIE_OPTIONS);
  setCookie(DEVICE_TOKEN_COOKIE_KEY, deviceToken, LOGIN_COOKIE_OPTIONS);
  setCookie(
    DEVICE_ENCRYPTION_KEY_COOKIE_KEY,
    deviceEncryptionKey,
    LOGIN_COOKIE_OPTIONS
  );
}

export function persistCircleOAuthCookies({
  nonce,
  provider,
  state,
}: {
  nonce?: string;
  provider: string;
  state: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  setCookie(OAUTH_PROVIDER_COOKIE_KEY, provider, LOGIN_COOKIE_OPTIONS);
  setCookie(OAUTH_STATE_COOKIE_KEY, state, LOGIN_COOKIE_OPTIONS);
  setCookie(OAUTH_NONCE_COOKIE_KEY, nonce ?? "", LOGIN_COOKIE_OPTIONS);
}

export function persistCircleOAuthBackups({
  nonce,
  provider,
  state,
}: {
  nonce?: string;
  provider: string;
  state: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  writeStorageValue(
    window.sessionStorage,
    OAUTH_PROVIDER_FALLBACK_STORAGE_KEY,
    provider
  );
  writeStorageValue(
    window.sessionStorage,
    OAUTH_STATE_FALLBACK_STORAGE_KEY,
    state
  );
  writeStorageValue(
    window.sessionStorage,
    OAUTH_NONCE_FALLBACK_STORAGE_KEY,
    nonce ?? ""
  );
  writeStorageValue(
    window.localStorage,
    OAUTH_PROVIDER_FALLBACK_STORAGE_KEY,
    provider
  );
  writeStorageValue(
    window.localStorage,
    OAUTH_STATE_FALLBACK_STORAGE_KEY,
    state
  );
  writeStorageValue(
    window.localStorage,
    OAUTH_NONCE_FALLBACK_STORAGE_KEY,
    nonce ?? ""
  );
  persistCircleOAuthCookies({ nonce, provider, state });
}

export function clearCircleOAuthCookies() {
  if (typeof window === "undefined") {
    return;
  }

  deleteCookie(OAUTH_PROVIDER_COOKIE_KEY, LOGIN_COOKIE_OPTIONS);
  deleteCookie(OAUTH_STATE_COOKIE_KEY, LOGIN_COOKIE_OPTIONS);
  deleteCookie(OAUTH_NONCE_COOKIE_KEY, LOGIN_COOKIE_OPTIONS);
}

export function clearCircleOAuthBackups() {
  if (typeof window === "undefined") {
    return;
  }

  removeStorageValue(
    window.sessionStorage,
    OAUTH_PROVIDER_FALLBACK_STORAGE_KEY
  );
  removeStorageValue(window.sessionStorage, OAUTH_STATE_FALLBACK_STORAGE_KEY);
  removeStorageValue(window.sessionStorage, OAUTH_NONCE_FALLBACK_STORAGE_KEY);
  removeStorageValue(
    window.localStorage,
    OAUTH_PROVIDER_FALLBACK_STORAGE_KEY
  );
  removeStorageValue(window.localStorage, OAUTH_STATE_FALLBACK_STORAGE_KEY);
  removeStorageValue(window.localStorage, OAUTH_NONCE_FALLBACK_STORAGE_KEY);
  clearCircleOAuthCookies();
}

export function persistCircleOAuthState({
  nonce,
  provider,
  state,
}: {
  nonce?: string;
  provider: string;
  state: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(SOCIAL_LOGIN_PROVIDER_STORAGE_KEY, provider);
  window.localStorage.setItem(SOCIAL_LOGIN_STATE_STORAGE_KEY, state);
  window.localStorage.setItem(SOCIAL_LOGIN_NONCE_STORAGE_KEY, nonce ?? "");
  persistCircleOAuthBackups({ nonce, provider, state });
}

export function restoreCircleOAuthStateFromCookies() {
  if (typeof window === "undefined") {
    return false;
  }

  const hasOAuthCallbackHash =
    window.location.hash.includes("state=") ||
    window.location.hash.includes("id_token=") ||
    window.location.hash.includes("access_token=");

  if (!hasOAuthCallbackHash) {
    return false;
  }

  const { nonce, provider, state } = readCircleOAuthBackup();
  const inferredProvider =
    provider ||
    (window.location.hash.includes("id_token=") && readGoogleLoginConfigFromCookies()
      ? SocialLoginProvider.GOOGLE
      : "");

  if (!inferredProvider || !state) {
    return false;
  }

  window.localStorage.setItem(SOCIAL_LOGIN_PROVIDER_STORAGE_KEY, inferredProvider);
  window.localStorage.setItem(SOCIAL_LOGIN_STATE_STORAGE_KEY, state);

  if (window.location.hash.includes("id_token=") && nonce) {
    window.localStorage.setItem(SOCIAL_LOGIN_NONCE_STORAGE_KEY, nonce);
  }

  persistCircleOAuthBackups({ nonce, provider: inferredProvider, state });

  return true;
}

export function clearGoogleLoginCookies() {
  if (typeof window === "undefined") {
    return;
  }

  deleteCookie(APP_ID_COOKIE_KEY, LOGIN_COOKIE_OPTIONS);
  deleteCookie(GOOGLE_CLIENT_ID_COOKIE_KEY, LOGIN_COOKIE_OPTIONS);
  deleteCookie(DEVICE_TOKEN_COOKIE_KEY, LOGIN_COOKIE_OPTIONS);
  deleteCookie(DEVICE_ENCRYPTION_KEY_COOKIE_KEY, LOGIN_COOKIE_OPTIONS);
}

export function clearCircleOAuthState() {
  removeStoredValue(SOCIAL_LOGIN_PROVIDER_STORAGE_KEY);
  removeStoredValue(SOCIAL_LOGIN_STATE_STORAGE_KEY);
  removeStoredValue(SOCIAL_LOGIN_NONCE_STORAGE_KEY);
  clearCircleOAuthBackups();
}

