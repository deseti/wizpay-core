import path from "node:path";
import webpack from "webpack";

import type { NextConfig } from "next";

const reownAppKitCoreShim = path.resolve(
  __dirname,
  "lib/shims/reown-appkit-core.ts"
);
const reownAppKitCoreShimImport = "./lib/shims/reown-appkit-core.ts";
const isDockerBuild = process.env.DOCKER_BUILD === "true";

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
      "@reown/appkit/core": reownAppKitCoreShimImport,
    },
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.alias ??= {};
    config.resolve.alias["@reown/appkit/core"] = reownAppKitCoreShim;
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
