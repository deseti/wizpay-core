/**
 * circle-auth.types.ts
 *
 * Shared TypeScript types for the Circle wallet integration.
 * Imported by circle-auth.service.ts, CircleWalletProvider, and any
 * other module that needs these domain types without pulling in the
 * full service implementation.
 */

import type { Address, Hex } from "viem";

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
