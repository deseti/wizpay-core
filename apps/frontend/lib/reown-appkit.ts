"use client";

import { createAppKit } from "@reown/appkit/react";

import {
  activeArcChain,
  REOWN_PROJECT_CONFIGURATION,
  SUPPORTED_CHAINS,
  wagmiAdapter,
} from "@/lib/wagmi";

export const REOWN_EXTERNAL_WALLET_FEATURES = Object.freeze({
  analytics: false,
  email: false,
  history: false,
  onramp: false,
  pay: false,
  receive: false,
  reownAuthentication: false,
  send: false,
  smartSessions: false,
  socials: false as const,
  swaps: false,
});

export const reownAppKit =
  wagmiAdapter && REOWN_PROJECT_CONFIGURATION.projectId
    ? createAppKit({
        adapters: [wagmiAdapter],
        networks: [...SUPPORTED_CHAINS],
        defaultNetwork: activeArcChain,
        projectId: REOWN_PROJECT_CONFIGURATION.projectId,
        metadata: {
          name: "WizPay",
          description: "External wallet connection for WizPay",
          url:
            process.env.NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL ??
            "http://localhost:3000",
          icons: [],
        },
        allowUnsupportedChain: false,
        coinbasePreference: "eoaOnly",
        defaultAccountTypes: { eip155: "eoa" },
        enableAuthLogger: false,
        enableEmbedded: false,
        enableInjected: true,
        enableWalletGuide: false,
        features: REOWN_EXTERNAL_WALLET_FEATURES,
        themeMode: "dark",
        // AppKit otherwise preloads its remote KHTeka assets, which the
        // production font-src policy rejects. Use the app's system stack.
        themeVariables: {
          "--w3m-font-family":
            '"Avenir Next", Avenir, "Segoe UI", Helvetica, Arial, sans-serif',
          "--apkt-font-family":
            '"Avenir Next", Avenir, "Segoe UI", Helvetica, Arial, sans-serif',
        },
      })
    : null;
