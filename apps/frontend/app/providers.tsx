"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { ExternalWalletProvider } from "@/components/providers/ExternalWalletProvider";
import "@/lib/reown-appkit";
import { config, REOWN_CONFIGURATION_ERROR } from "@/lib/wagmi";
import { PwaRuntime } from "@/src/features/pwa/components/PwaRuntime";
import { CapabilityProvider } from "@/components/providers/CapabilityProvider";

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

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={config}>
        <CapabilityProvider>
          <ExternalWalletProvider>
            <PwaRuntime />
            {children}
          </ExternalWalletProvider>
        </CapabilityProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
