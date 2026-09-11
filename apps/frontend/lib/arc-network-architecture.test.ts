import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

describe("Arc network configuration architecture", () => {
  const compose = read("docker-compose.yml");
  const testnetCompose = read("deploy/arc-testnet/compose.yml");
  const mainnetCompose = read("deploy/arc-mainnet/compose.yml");
  const frontendDockerfile = read("apps/frontend/Dockerfile");
  const backendDockerfile = read("apps/backend/Dockerfile");
  const nextConfig = read("apps/frontend/next.config.ts");

  it("uses explicit isolated selectors for backend runtime and frontend build", () => {
    expect(compose.match(/^\s+WIZPAY_ARC_NETWORK:/gm)).toHaveLength(3);
    expect(compose).not.toContain("${WIZPAY_ARC_NETWORK:");
    expect(testnetCompose).toContain("name: wizpay-arc-testnet");
    expect(testnetCompose).toContain("WIZPAY_ARC_NETWORK: arc-testnet");
    expect(mainnetCompose).toContain("name: wizpay-arc-mainnet");
    expect(mainnetCompose).toContain("WIZPAY_ARC_NETWORK: arc-mainnet");
    expect(testnetCompose).not.toContain("ARC_MAINNET_");
    expect(mainnetCompose).not.toContain("ARC_TESTNET_");
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
