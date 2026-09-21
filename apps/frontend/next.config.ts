import path from "node:path";

import type { NextConfig } from "next";
import { parseArcNetworkKey } from "@wizpay/arc-network";
import { frontendSecurityHeaderRules } from "./lib/security-headers";

const arcNetworkKey = parseArcNetworkKey(process.env.WIZPAY_ARC_NETWORK);
const publicArcNetworkKey = process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK;

if (
  publicArcNetworkKey !== undefined &&
  publicArcNetworkKey !== arcNetworkKey
) {
  throw new Error(
    "NEXT_PUBLIC_WIZPAY_ARC_NETWORK conflicts with WIZPAY_ARC_NETWORK.",
  );
}

const emptyModuleShim = path.resolve(__dirname, "lib/shims/empty-module.js");
const emptyModuleShimImport = "./lib/shims/empty-module.js";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  env: {
    NEXT_PUBLIC_WIZPAY_ARC_NETWORK: arcNetworkKey,
  },
  headers: async () => frontendSecurityHeaderRules(process.env),
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.qrserver.com",
      },
    ],
  },
  turbopack: {
    root: path.resolve(__dirname, "../.."),
    resolveAlias: {
      "@react-native-async-storage/async-storage": emptyModuleShimImport,
      "pino-pretty": emptyModuleShimImport,
      "@x402/core/client": emptyModuleShimImport,
      "@x402/evm": emptyModuleShimImport,
      "@x402/evm/exact/client": emptyModuleShimImport,
      "@x402/svm/exact/client": emptyModuleShimImport,
    },
  },
  webpack: (config, { webpack }) => {
    config.resolve ??= {};
    config.resolve.alias ??= {};
    config.resolve.alias["@react-native-async-storage/async-storage"] =
      emptyModuleShim;
    config.resolve.alias["pino-pretty"] = emptyModuleShim;
    // Wagmi's Coinbase connector pulls optional @x402 payment protocol
    // modules through @coinbase/cdp-sdk. WizPay does not use x402; stub them
    // so a Mainnet production build does not require those packages.
    config.resolve.alias["@x402/core/client"] = emptyModuleShim;
    config.resolve.alias["@x402/evm"] = emptyModuleShim;
    config.resolve.alias["@x402/evm/exact/client"] = emptyModuleShim;
    config.resolve.alias["@x402/svm/exact/client"] = emptyModuleShim;
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^@x402(?:\/|$)/,
        emptyModuleShim,
      ),
    );
    // viem bundles the Tempo chain whose virtualMasterPool.js uses a dynamic
    // require() that webpack cannot statically analyse, producing a TDZ circular
    // dependency crash at runtime.  WizPay never uses the Tempo chain, so we
    // replace that single file with an empty stub.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /viem[\\/]node_modules[\\/]ox[\\/]_esm[\\/]tempo[\\/]internal[\\/]virtualMasterPool\.js/,
        path.resolve(__dirname, "lib/shims/viem-tempo-virtualMasterPool.js"),
      ),
    );
    return config;
  },
};

export default nextConfig;
