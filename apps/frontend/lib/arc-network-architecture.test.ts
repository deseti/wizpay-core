import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

describe("Arc network configuration architecture", () => {
  const compose = read("docker-compose.yml");
  const frontendDockerfile = read("apps/frontend/Dockerfile");
  const backendDockerfile = read("apps/backend/Dockerfile");
  const nextConfig = read("apps/frontend/next.config.ts");

  it("uses one required operator selector for backend runtime and frontend build", () => {
    const requiredSelector =
      "${WIZPAY_ARC_NETWORK:?WIZPAY_ARC_NETWORK is required}";
    expect(compose.match(/^\s+WIZPAY_ARC_NETWORK:/gm)).toHaveLength(3);
    expect(
      compose.match(
        new RegExp(requiredSelector.replace(/[${}:?]/g, "\\$&"), "g"),
      ),
    ).toHaveLength(3);
    expect(frontendDockerfile).toContain("ARG WIZPAY_ARC_NETWORK");
    expect(frontendDockerfile).toContain(
      "ENV WIZPAY_ARC_NETWORK=$WIZPAY_ARC_NETWORK",
    );
  });

  it("derives the public identity in next.config without a public operator selector", () => {
    expect(nextConfig).toContain(
      "parseArcNetworkKey(process.env.WIZPAY_ARC_NETWORK)",
    );
    expect(nextConfig).toContain(
      "NEXT_PUBLIC_WIZPAY_ARC_NETWORK: arcNetworkKey",
    );
    expect(compose).not.toContain("NEXT_PUBLIC_WIZPAY_ARC_NETWORK:");
  });

  it("does not preserve active Testnet RPC, chain, token, or contract defaults", () => {
    for (const activeName of [
      "RPC_URL:",
      "ARC_RPC_URL:",
      "CHAIN_ID:",
      "NEXT_PUBLIC_RPC_URL:",
      "NEXT_PUBLIC_ARC_USDC:",
      "NEXT_PUBLIC_CONTRACT_ADDRESS:",
      "NEXT_PUBLIC_WIZPAY_ADDRESS:",
      "NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS:",
    ]) {
      expect(compose).not.toMatch(
        new RegExp(
          `^\\s+${activeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "m",
        ),
      );
    }
  });

  it("keeps XyloNet and bridge settings explicitly Testnet-scoped", () => {
    expect(compose).toContain("APP_XYLONET_CHAIN_ID:");
    expect(compose).toContain("ARC_TESTNET_RPC_URL:");
    expect(compose).toContain("NEXT_PUBLIC_ARC_TESTNET_RPC_URL:");
  });

  it("copies the shared registry into both application images", () => {
    expect(frontendDockerfile).toContain("COPY packages/arc-network");
    expect(backendDockerfile).toContain("COPY packages/arc-network");
  });
});
