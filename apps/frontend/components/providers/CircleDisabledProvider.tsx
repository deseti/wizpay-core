"use client";

import type { CircleWalletContextValue } from "@/services/circle-auth.service";
import { CircleWalletContext } from "@/components/providers/circle-wallet-context";

/**
 * Inert Circle context stub for Arc Mainnet.
 *
 * Mainnet is external-wallet-only: this provider mounts no Circle SDK, runs
 * no auth effects, performs no Circle HTTP, and exposes no login actions.
 * It exists only so components that directly consume useCircleWallet keep
 * rendering the external-wallet path on Mainnet without depending on any
 * Circle provider state. Arc Testnet continues to use CircleWalletProvider.
 *
 * This module must never import Circle runtime code (SDK hooks, auth
 * services beyond types, passkey helpers). Type-only imports are erased at
 * compile time and are the only Circle coupling allowed here.
 */
const DISABLED_MAINNET_VALUE: CircleWalletContextValue = {
  arcWallet: null,
  authMethod: null,
  authError: null,
  authStatus: null,
  authenticated: false,
  closeLogin: () => {},
  createContractExecutionChallenge: async () => {
    throw new Error("Circle App Wallet is unavailable on Arc Mainnet.");
  },
  createTypedDataChallenge: async () => {
    throw new Error("Circle App Wallet is unavailable on Arc Mainnet.");
  },
  createTransferChallenge: async () => {
    throw new Error("Circle App Wallet is unavailable on Arc Mainnet.");
  },
  ensureSessionReady: async () => {},
  executeChallenge: async () => {
    throw new Error("Circle App Wallet is unavailable on Arc Mainnet.");
  },
  getWalletBalances: async () => [],
  hasPendingEmailOtp: false,
  isAuthenticating: false,
  initializationPhase: "recoverable_error",
  login: () => {},
  loginMethodLabel: "External",
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

export function CircleDisabledProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CircleWalletContext.Provider value={DISABLED_MAINNET_VALUE}>
      {children}
    </CircleWalletContext.Provider>
  );
}
