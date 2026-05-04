import { createSolanaAdapterFromProvider } from "@circle-fin/adapter-solana";
import { ViemAdapter } from "@circle-fin/adapter-viem-v2";
import {
  ArcTestnet,
  EthereumSepolia,
  SolanaDevnet,
} from "@circle-fin/app-kit/chains";
import {
  createPublicClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";

import type { InjectedSolanaWalletProvider } from "@/components/providers/SolanaWalletProvider";

const EXTERNAL_EVM_CAPABILITIES = {
  addressContext: "user-controlled" as const,
  supportedChains: [ArcTestnet, EthereumSepolia],
};

const EXTERNAL_SOLANA_CAPABILITIES = {
  addressContext: "user-controlled" as const,
  supportedChains: [SolanaDevnet],
};

function resolvePublicClient(
  chainId: number,
  chainClients: Partial<Record<number, PublicClient>>,
  walletClient: WalletClient
) {
  const cachedClient = chainClients[chainId];

  if (cachedClient) {
    return cachedClient;
  }

  const walletChain = walletClient.chain;

  if (!walletChain || walletChain.id !== chainId) {
    throw new Error(`Missing public client for chain ${chainId}.`);
  }

  const fallbackRpcUrl =
    walletChain.rpcUrls.default.http[0] ?? walletChain.rpcUrls.public?.http[0];

  if (!fallbackRpcUrl) {
    throw new Error(`Missing RPC URL for chain ${walletChain.name}.`);
  }

  return createPublicClient({
    chain: walletChain,
    transport: http(fallbackRpcUrl),
  });
}

export function createExternalEvmWalletAdapter({
  walletClient,
  publicClientsByChainId,
}: {
  walletClient: WalletClient;
  publicClientsByChainId: Partial<Record<number, PublicClient>>;
}) {
  return new ViemAdapter(
    {
      getPublicClient: ({ chain }) =>
        resolvePublicClient(chain.id, publicClientsByChainId, walletClient),
      getWalletClient: async () => walletClient,
    },
    EXTERNAL_EVM_CAPABILITIES
  );
}

export async function createExternalSolanaWalletAdapter({
  provider,
}: {
  provider: InjectedSolanaWalletProvider;
}) {
  return createSolanaAdapterFromProvider({
    provider,
    capabilities: EXTERNAL_SOLANA_CAPABILITIES,
  });
}