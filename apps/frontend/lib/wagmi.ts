import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { coinbaseWallet, safe } from "@wagmi/connectors";
import { createConfig, custom, http } from "wagmi";
import { defineChain, type Chain } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";
import {
  getArcExplorerResource,
  getArcNetworkByKey,
  getArcRpcResource,
  requireAvailableArcResource,
} from "@wizpay/arc-network";
import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";

export const ACTIVE_ARC_RPC_URL = ACTIVE_ARC_NETWORK.rpcUrl;
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

function defineArcMainnet() {
  const network = getArcNetworkByKey("arc-mainnet");
  const rpc = getArcRpcResource("arc-mainnet");
  const explorer = getArcExplorerResource("arc-mainnet");
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
    testnet: false,
  });
}

export const arcMainnetNetwork = defineArcMainnet();
export const activeArcChain = arcMainnetNetwork;

// Arc Mainnet is the default WizPay application runtime. The additional
// mainnet chains below exist exclusively so the connected external wallet can
// sign official Circle CCTP bridge legs (source approval/burn, destination
// mint) on the bridge counterparty chain. Payroll, send, swap, invoice, and
// payment-link flows always pin to activeArcChain and never follow the
// wallet's selected chain implicitly.
export const BRIDGE_CHAINS = [
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
] as const;

export const SUPPORTED_CHAINS = [activeArcChain, ...BRIDGE_CHAINS] as const;
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
  [mainnet.id]: http(),
  [base.id]: http(),
  [arbitrum.id]: http(),
  [optimism.id]: http(),
  [polygon.id]: http(),
  [avalanche.id]: http(),
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
