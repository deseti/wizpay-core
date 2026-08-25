import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, fallback, http } from "wagmi";
import { defineChain, type Chain } from "viem";
import { sepolia } from "viem/chains";
import { BRIDGE_TESTNET_BY_CODE } from "@wizpay/bridge-registry";

export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.io";

const configuredArcTestnetRpcUrl =
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL?.trim();

if (
  configuredArcTestnetRpcUrl &&
  configuredArcTestnetRpcUrl !== ARC_TESTNET_RPC_URL
) {
  throw new Error(
    `NEXT_PUBLIC_ARC_TESTNET_RPC_URL must be exactly ${ARC_TESTNET_RPC_URL}.`,
  );
}

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
export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? "";
export const HAS_WALLETCONNECT_PROJECT_ID = WALLETCONNECT_PROJECT_ID.length > 0;

/**
 * Arc Testnet — custom chain definition
 */
export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ARC_TESTNET_RPC_URL],
    },
    public: {
      http: [ARC_TESTNET_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

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
  arcTestnet,
  ethereumSepolia,
  baseSepolia,
  arbitrumSepolia,
  opSepolia,
  monadTestnet,
] as const;
export const CHAIN_BY_ID: Record<number, Chain> = {
  [arcTestnet.id]: arcTestnet,
  [ethereumSepolia.id]: ethereumSepolia,
  [baseSepolia.id]: baseSepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [opSepolia.id]: opSepolia,
  [monadTestnet.id]: monadTestnet,
};
export const CHAIN_NAME_BY_ID: Record<number, string> = {
  [arcTestnet.id]: arcTestnet.name,
  [ethereumSepolia.id]: ethereumSepolia.name,
  [baseSepolia.id]: baseSepolia.name,
  [arbitrumSepolia.id]: arbitrumSepolia.name,
  [opSepolia.id]: opSepolia.name,
  [monadTestnet.id]: monadTestnet.name,
};
export const SUPPORTED_CHAIN_IDS = new Set<number>(
  SUPPORTED_CHAINS.map((chain) => chain.id),
);

const RAINBOWKIT_PROJECT_ID = HAS_WALLETCONNECT_PROJECT_ID
  ? WALLETCONNECT_PROJECT_ID
  : "wizpay-local-rainbowkit";

const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [
        rabbyWallet,
        metaMaskWallet,
        rainbowWallet,
        coinbaseWallet,
        ...(HAS_WALLETCONNECT_PROJECT_ID ? [walletConnectWallet] : []),
        injectedWallet,
      ],
    },
  ],
  {
    appName: "WizPay",
    projectId: RAINBOWKIT_PROJECT_ID,
  },
);

/**
 * Wagmi configuration for both public reads and RainbowKit external wallets.
 * Circle user-controlled wallets remain isolated behind CircleWalletProvider.
 */
export const config = createConfig({
  chains: SUPPORTED_CHAINS,
  connectors,
  ssr: true,
  transports: {
    [arcTestnet.id]: http(ARC_TESTNET_RPC_URL, {
      retryCount: 1,
      timeout: 10_000,
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
  },
});
