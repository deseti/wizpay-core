"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { CircleApiProxyProvider } from "@/components/providers/CircleApiProxyProvider";
import { CircleDisabledProvider } from "@/components/providers/CircleDisabledProvider";
import { CircleWalletProvider } from "@/components/providers/CircleWalletProvider";
import { ExternalWalletProvider } from "@/components/providers/ExternalWalletProvider";
import { HybridWalletProvider } from "@/components/providers/HybridWalletProvider";
import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";
import "@/lib/reown-appkit";
import { config, REOWN_CONFIGURATION_ERROR } from "@/lib/wagmi";
import { PwaRuntime } from "@/src/features/pwa/components/PwaRuntime";
import { CapabilityProvider } from "@/components/providers/CapabilityProvider";

const IS_ARC_MAINNET = ACTIVE_ARC_NETWORK.key === "arc-mainnet";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 2,
          },
        },
      }),
  );

  if (REOWN_CONFIGURATION_ERROR) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6">
        <div
          role="alert"
          className="max-w-lg rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-100"
        >
          <h1 className="text-lg font-semibold">
            Wallet configuration unavailable
          </h1>
          <p className="mt-2">{REOWN_CONFIGURATION_ERROR}</p>
        </div>
      </main>
    );
  }

  // Arc Mainnet is external-wallet-only: the Mainnet tree mounts no Circle
  // SDK provider, no Circle API proxy, and no hybrid Circle state. The inert
  // CircleDisabledProvider exists only so components that directly consume
  // useCircleWallet keep rendering the external-wallet path without any
  // Circle runtime behind them. Arc Testnet keeps the hybrid Circle tree.
  if (IS_ARC_MAINNET) {
    return (
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={config}>
          <CapabilityProvider>
            <CircleDisabledProvider>
              <ExternalWalletProvider>
                <PwaRuntime />
                {children}
              </ExternalWalletProvider>
            </CircleDisabledProvider>
          </CapabilityProvider>
        </WagmiProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={config}>
        <CircleWalletProvider enabled={true}>
          <CapabilityProvider>
            <HybridWalletProvider>
              <CircleApiProxyProvider enabled={true}>
                <PwaRuntime />
                {children}
              </CircleApiProxyProvider>
            </HybridWalletProvider>
          </CapabilityProvider>
        </CircleWalletProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
