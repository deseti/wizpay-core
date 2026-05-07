import path from "node:path";
import webpack from "webpack";

import type { NextConfig } from "next";

const emptyModuleShim = path.resolve(__dirname, "lib/shims/empty-module.js");
const emptyModuleShimImport = "./lib/shims/empty-module.js";

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.qrserver.com",
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: __dirname,
    resolveAlias: {
      "@react-native-async-storage/async-storage": emptyModuleShimImport,
      "pino-pretty": emptyModuleShimImport,
    },
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.alias ??= {};
    config.resolve.alias["@react-native-async-storage/async-storage"] =
      emptyModuleShim;
    config.resolve.alias["pino-pretty"] = emptyModuleShim;
    // viem bundles the Tempo chain whose virtualMasterPool.js uses a dynamic
    // require() that webpack cannot statically analyse, producing a TDZ circular
    // dependency crash at runtime.  WizPay never uses the Tempo chain, so we
    // replace that single file with an empty stub.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /viem[\\/]node_modules[\\/]ox[\\/]_esm[\\/]tempo[\\/]internal[\\/]virtualMasterPool\.js/,
        path.resolve(__dirname, "lib/shims/viem-tempo-virtualMasterPool.js")
      )
    );
    return config;
  },
};

export default nextConfig;
