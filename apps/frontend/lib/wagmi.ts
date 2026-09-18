import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { coinbaseWallet, safe } from "@wagmi/connectors";
import { createConfig, custom, fallback, http } from "wagmi";
import { defineChain, type Chain } from "viem";
import { sepolia } from "viem/chains";
import { BRIDGE_TESTNET_BY_CODE } from "@wizpay/bridge-registry";
import {
  getArcExplorerResource,
  getArcNetworkByKey,
  getArcRpcResource,
  requireAvailableArcResource,
  type ArcNetworkKey,
} from "@wizpay/arc-network";
import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";

/** Testnet-only compatibility name; value is selected from the shared registry. */
export const ACTIVE_ARC_RPC_URL = ACTIVE_ARC_NETWORK.rpcUrl;
/** Testnet-only compatibility export. It is absent on Arc Mainnet. */
export const ARC_TESTNET_RPC_URL =
  ACTIVE_ARC_NETWORK.key === "arc-testnet" ? ACTIVE_ARC_RPC_URL : undefined;

const DEFAULT_ETHEREUM_SEPOLIA_RPC_URLS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://ethereum-sepolia.publicnode.com",
];

function parseRpcUrls(
  explicitUrl: string | undefined,
  explicitList: string | undefined,
  defaults: string[],
) {
  const configured = [explicitList, explicitUrl].flatMap((value) =>
    (value ?? "")
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  return Array.from(new Set(configured.length > 0 ? configured : defaults));
}

function createFallbackTransport(urls: string[]) {
  return fallback(
    urls.map((url) =>
      http(url, {
        retryCount: 1,
        timeout: 10_000,
      }),
    ),
  );
}

export const ETHEREUM_SEPOLIA_RPC_URLS = parseRpcUrls(
  process.env.NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL,
  process.env.NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URLS,
  DEFAULT_ETHEREUM_SEPOLIA_RPC_URLS,
);

export const ETHEREUM_SEPOLIA_RPC_URL = ETHEREUM_SEPOLIA_RPC_URLS[0];
export const REOWN_PROJECT_ID_ENV = "NEXT_PUBLIC_REOWN_PROJECT_ID";

export function resolveReownProjectId(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error(
      `${REOWN_PROJECT_ID_ENV} is required for external wallet connections.`,
    );
  }
  if (value !== value.trim()) {
    throw new Error(
      `${REOWN_PROJECT_ID_ENV} must not contain surrounding whitespace.`,
    );
  }
  return value;
}

export function readReownProjectConfiguration(
  value: string | undefined,
): { projectId: string; error: null } | { projectId: null; error: string } {
  try {
    return { projectId: resolveReownProjectId(value), error: null };
  } catch (error) {
    return {
      projectId: null,
      error:
        error instanceof Error
          ? error.message
          : `${REOWN_PROJECT_ID_ENV} is invalid.`,
    };
  }
}

export const REOWN_PROJECT_CONFIGURATION = readReownProjectConfiguration(
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID,
);
export const REOWN_CONFIGURATION_ERROR = REOWN_PROJECT_CONFIGURATION.error;

function defineArcNetwork(key: ArcNetworkKey) {
  const network = getArcNetworkByKey(key);
  const rpc = getArcRpcResource(key);
  const explorer = getArcExplorerResource(key);
  const rpcUrls =
    rpc.status === "available" ? [requireAvailableArcResource(rpc).url] : [];
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: {
      default: { http: rpcUrls },
      public: { http: rpcUrls },
    },
    ...(explorer.status === "available"
      ? {
          blockExplorers: {
            default: {
              name: "ArcScan",
              url: requireAvailableArcResource(explorer).baseUrl,
            },
          },
        }
      : {}),
    testnet: network.testnet,
  });
}

export const arcTestnetNetwork = defineArcNetwork("arc-testnet");
export const arcMainnetNetwork = defineArcNetwork("arc-mainnet");
export const activeArcChain =
  ACTIVE_ARC_NETWORK.key === "arc-mainnet"
    ? arcMainnetNetwork
    : arcTestnetNetwork;

/** @deprecated Use activeArcChain. Retained while Testnet-only flows migrate. */
export const arcTestnet = activeArcChain;

export const ethereumSepolia = defineChain({
  ...sepolia,
  rpcUrls: {
    ...sepolia.rpcUrls,
    default: {
      http: ETHEREUM_SEPOLIA_RPC_URLS,
    },
    public: {
      http: ETHEREUM_SEPOLIA_RPC_URLS,
    },
  },
});

function configuredRpcUrl(value: string | undefined, fallbackUrl: string) {
  const normalized = value?.trim();
  return normalized || fallbackUrl;
}

function defineBridgeTestnet(
  code: "BASE-SEPOLIA" | "ARB-SEPOLIA" | "OP-SEPOLIA" | "MONAD-TESTNET",
  configuredUrl: string | undefined,
) {
  const network = BRIDGE_TESTNET_BY_CODE[code];
  const rpcUrl = configuredRpcUrl(configuredUrl, network.defaultRpcUrl);
  return defineChain({
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
    blockExplorers: {
      default: {
        name: `${network.name} Explorer`,
        url: network.explorerBaseUrl,
      },
    },
    testnet: true,
  });
}

export const baseSepolia = defineBridgeTestnet(
  "BASE-SEPOLIA",
  process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
);
export const arbitrumSepolia = defineBridgeTestnet(
  "ARB-SEPOLIA",
  process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL,
);
export const opSepolia = defineBridgeTestnet(
  "OP-SEPOLIA",
  process.env.NEXT_PUBLIC_OP_SEPOLIA_RPC_URL,
);
export const monadTestnet = defineBridgeTestnet(
  "MONAD-TESTNET",
  process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL,
);

export const SUPPORTED_CHAINS = [
  activeArcChain,
  ...(ACTIVE_ARC_NETWORK.key === "arc-testnet"
    ? [ethereumSepolia, baseSepolia, arbitrumSepolia, opSepolia, monadTestnet]
    : []),
] as const;
export const CHAIN_BY_ID: Record<number, Chain> = Object.fromEntries(
  SUPPORTED_CHAINS.map((chain) => [chain.id, chain]),
);
export const CHAIN_NAME_BY_ID: Record<number, string> = Object.fromEntries(
  SUPPORTED_CHAINS.map((chain) => [chain.id, chain.name]),
);
export const SUPPORTED_CHAIN_IDS = new Set<number>(
  SUPPORTED_CHAINS.map((chain) => chain.id),
);

const transports = {
  [activeArcChain.id]: ACTIVE_ARC_RPC_URL
    ? http(ACTIVE_ARC_RPC_URL, { retryCount: 1, timeout: 10_000 })
    : custom({
        request: async () => {
          throw new Error(
            "Arc Mainnet RPC is unavailable; transactions remain disabled.",
          );
        },
      }),
  [ethereumSepolia.id]: createFallbackTransport(ETHEREUM_SEPOLIA_RPC_URLS),
  [baseSepolia.id]: http(baseSepolia.rpcUrls.default.http[0], {
    retryCount: 1,
    timeout: 10_000,
  }),
  [arbitrumSepolia.id]: http(arbitrumSepolia.rpcUrls.default.http[0], {
    retryCount: 1,
    timeout: 10_000,
  }),
  [opSepolia.id]: http(opSepolia.rpcUrls.default.http[0], {
    retryCount: 1,
    timeout: 10_000,
  }),
  [monadTestnet.id]: http(monadTestnet.rpcUrls.default.http[0], {
    retryCount: 1,
    timeout: 10_000,
  }),
} as const;

const externalWalletConnectors = [
  coinbaseWallet({
    appName: "WizPay",
    preference: "eoaOnly",
    version: "4",
  }),
  safe({ shimDisconnect: true }),
];

export const wagmiAdapter = REOWN_PROJECT_CONFIGURATION.projectId
  ? new WagmiAdapter({
      networks: [...SUPPORTED_CHAINS],
      projectId: REOWN_PROJECT_CONFIGURATION.projectId,
      connectors: externalWalletConnectors,
      ssr: true,
      transports,
    })
  : null;

/**
 * Wagmi configuration for public reads and Reown-managed external wallets.
 * The empty-connector fallback exists only to render the fail-closed missing
 * project-ID error; no wallet connection can be initiated through it.
 */
export const config =
  wagmiAdapter?.wagmiConfig ??
  createConfig({
    chains: SUPPORTED_CHAINS,
    connectors: [],
    ssr: true,
    transports,
  });
