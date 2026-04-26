import path from "node:path";

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
    return config;
  },
};

export default nextConfig;
