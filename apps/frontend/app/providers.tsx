"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { useState } from "react";
import { midnightTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { CircleApiProxyProvider } from "@/components/providers/CircleApiProxyProvider";
import { CircleWalletProvider } from "@/components/providers/CircleWalletProvider";
import { HybridWalletProvider } from "@/components/providers/HybridWalletProvider";
import { SolanaWalletProvider } from "@/components/providers/SolanaWalletProvider";
import { arcTestnet, config } from "@/lib/wagmi";
import { PwaRuntime } from "@/src/features/pwa/components/PwaRuntime";

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
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={config}>
        <RainbowKitProvider
          initialChain={arcTestnet}
          theme={midnightTheme()}
        >
          <CircleWalletProvider>
            <SolanaWalletProvider>
              <HybridWalletProvider>
                <CircleApiProxyProvider>
                  <PwaRuntime />
                  {children}
                </CircleApiProxyProvider>
              </HybridWalletProvider>
            </SolanaWalletProvider>
          </CircleWalletProvider>
        </RainbowKitProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
