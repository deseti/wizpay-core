import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import type { Connector } from "wagmi";
import {
  BRIDGE_TESTNET_BY_CODE,
  type BridgeTestnetCode,
  type BridgeTestnetDefinition,
} from "@wizpay/bridge-registry";

const BROWSER_RPC_URLS: Record<BridgeTestnetCode, string | undefined> = {
  "ARC-TESTNET": process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL,
  "ETH-SEPOLIA": process.env.NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL,
  "BASE-SEPOLIA": process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
  "ARB-SEPOLIA": process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL,
  "OP-SEPOLIA": process.env.NEXT_PUBLIC_OP_SEPOLIA_RPC_URL,
  "MONAD-TESTNET": process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL,
};

export function getBridgeRegistryEntry(code: string | undefined) {
  if (!code) return undefined;
  return BRIDGE_TESTNET_BY_CODE[code as BridgeTestnetCode];
}

export function resolveBridgeRpcUrl(
  network: BridgeTestnetDefinition | undefined,
  configuredUrl?: string,
) {
  if (!network) return undefined;
  const url = (configuredUrl ?? BROWSER_RPC_URLS[network.code])?.trim();
  const resolved = url || network.defaultRpcUrl;
  if (!/^https:\/\//i.test(resolved)) return undefined;
  return resolved;
}

export function resolveBridgeRpcUrls(
  network: BridgeTestnetDefinition | undefined,
  configuredUrls?: readonly string[],
) {
  if (!network) return [];
  const environmentUrl = BROWSER_RPC_URLS[network.code]?.trim();
  const candidates = [
    ...(configuredUrls ?? []),
    environmentUrl,
    network.defaultRpcUrl,
  ];
  return [...new Set(candidates.filter((url): url is string => Boolean(url)))]
    .map((url) => url.trim())
    .filter((url) => /^https:\/\//i.test(url));
}

export function createBridgePublicClient(
  network: BridgeTestnetDefinition | undefined,
  configuredUrl?: string,
): PublicClient | undefined {
  const rpcUrl = resolveBridgeRpcUrl(network, configuredUrl);
  if (!network || !rpcUrl) return undefined;

  const chain: Chain = {
    id: network.chainId,
    name: network.name,
    nativeCurrency: {
      name: network.gasCurrency,
      symbol: network.gasCurrency,
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] },
    },
    testnet: true,
  };

  return createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
  });
}

export function createBridgePublicClients(
  network: BridgeTestnetDefinition | undefined,
  configuredUrls?: readonly string[],
): PublicClient[] {
  if (!network) return [];
  return resolveBridgeRpcUrls(network, configuredUrls).map((rpcUrl) => {
    const chain: Chain = {
      id: network.chainId,
      name: network.name,
      nativeCurrency: {
        name: network.gasCurrency,
        symbol: network.gasCurrency,
        decimals: 18,
      },
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
      testnet: true,
    };
    return createPublicClient({
      chain,
      transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
  });
}

export async function switchBridgeWalletChain(input: {
  targetChainId: number;
  switchChain: (input: { chainId: number }) => Promise<{ id: number }>;
}) {
  const switched = await input.switchChain({ chainId: input.targetChainId });
  if (switched.id !== input.targetChainId) {
    throw new Error(
      "Wallet network switch did not reach the required testnet.",
    );
  }
  return switched.id;
}

export interface BridgeReadinessInputs {
  walletAddress?: Address;
  walletAccount?: Address;
  connector?: Connector;
  walletClient?: {
    account?: { address?: Address } | Address | null;
    transport?: unknown;
  };
  connectorClient?: {
    transport?: unknown;
  };
  source?: BridgeTestnetDefinition;
  destination?: BridgeTestnetDefinition;
  sourceRpcUrl?: string;
  destinationRpcUrl?: string;
  sourceChainId?: number;
  destinationChainId?: number;
  sourceClient?: PublicClient;
  destinationClient?: PublicClient;
}

export function getBridgeReadinessError(
  input: BridgeReadinessInputs,
): string | null {
  if (!input.walletAddress)
    return "The connected wallet address is unavailable.";
  if (!input.connector) return "The external wallet connector is unavailable.";
  if (!input.connectorClient?.transport) {
    return "The external wallet provider is unavailable.";
  }
  if (!input.walletClient?.transport) {
    return "The external wallet signing client is unavailable.";
  }
  const walletClientAccount = input.walletClient.account;
  const walletClientAddress =
    typeof walletClientAccount === "string"
      ? walletClientAccount
      : walletClientAccount?.address;
  if (!input.walletAccount || !walletClientAddress) {
    return "The external wallet account is unavailable.";
  }
  if (input.walletAccount.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return "The external wallet account does not match the connected address.";
  }
  if (walletClientAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return "The external wallet account does not match the connected address.";
  }
  if (!input.source) return "The selected source testnet is not registered.";
  if (!input.destination) {
    return "The selected destination testnet is not registered.";
  }
  if (!input.sourceRpcUrl) return "The source testnet RPC URL is unavailable.";
  if (!input.destinationRpcUrl) {
    return "The destination testnet RPC URL is unavailable.";
  }
  if (input.sourceChainId !== input.source.chainId) {
    return "The source public client chain is not configured correctly.";
  }
  if (input.destinationChainId !== input.destination.chainId) {
    return "The destination public client chain is not configured correctly.";
  }
  if (!input.sourceClient)
    return "The source public RPC client is unavailable.";
  if (!input.destinationClient) {
    return "The destination public RPC client is unavailable.";
  }
  return null;
}
