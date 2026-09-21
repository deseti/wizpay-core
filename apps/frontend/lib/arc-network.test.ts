import { describe, expect, it } from "vitest";

import {
  assertFrontendTransactionsAvailable,
  createFrontendBuildSafeArcNetworkConfiguration,
  createFrontendTransactionalArcNetworkConfiguration,
  getExplorerTxUrlForNetwork,
  requireFrontendTransactionalArcNetworkConfiguration,
  resolveFrontendArcNetworkResourceState,
  validateFrontendArcNetworkOverrides,
} from "./arc-network";

const TX_HASH = `0x${"a".repeat(64)}`;
const MAINNET_RPC = "https://rpc.mainnet.arc.io";
const MAINNET_EXPLORER = "https://explorer.arc.io";
const MAINNET_USDC = "0x3600000000000000000000000000000000000000";
const MAINNET_EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const MAINNET_WIZPAY = "0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34";
const MAINNET_EXECUTOR = "0x7A051F17B237750EF9D4E63fb75381B9F8755774";

describe("frontend Arc network configuration", () => {
  it("rejects every non-Mainnet selector", () => {
    for (const selector of [
      "arc-test",
      "unknown",
      "ARC-MAINNET",
      " arc-mainnet ",
    ]) {
      expect(() =>
        createFrontendTransactionalArcNetworkConfiguration(selector),
      ).toThrow();
    }
  });

  it.each([undefined, ""])("rejects missing selectors: %p", (selector) => {
    expect(() =>
      createFrontendTransactionalArcNetworkConfiguration(selector),
    ).toThrow();
  });

  it("creates the live Arc Mainnet transactional configuration from confirmed resources", () => {
    const state = resolveFrontendArcNetworkResourceState("arc-mainnet");
    expect(state.key).toBe("arc-mainnet");
    expect(state.network.chainId).toBe(5_042);
    expect(state.uniswapSwapRouter02).toMatchObject({
      status: "published",
      executable: false,
    });
    expect(state.mainnetUniswapV4).toMatchObject({
      chainId: 5_042,
      capabilityEnabled: false,
      executable: false,
      poolKey: { status: "candidate", executable: false },
      poolId: { status: "candidate", executable: false },
      poolUniqueness: { status: "unavailable" },
    });
    const config = requireFrontendTransactionalArcNetworkConfiguration(state);
    expect(config).toMatchObject({
      key: "arc-mainnet",
      chainId: 5_042,
      rpcUrl: MAINNET_RPC,
      explorerBaseUrl: MAINNET_EXPLORER,
      transactionalAvailable: true,
      tokens: {
        USDC: { address: MAINNET_USDC },
        EURC: { address: MAINNET_EURC },
      },
      contracts: {
        wizpay: {
          contract: "WizPayPayrollMainnet",
          address: MAINNET_WIZPAY,
        },
        wizpaySwapExecutorMainnet: {
          address: MAINNET_EXECUTOR,
        },
      },
    });
    expect(config.contracts).not.toHaveProperty("wizpaySwapExecutorV2");
  });

  it("permits a Mainnet build with confirmed resources while capabilities stay opt-in", () => {
    const config =
      createFrontendBuildSafeArcNetworkConfiguration("arc-mainnet");
    expect(config).toMatchObject({
      key: "arc-mainnet",
      name: "Arc Mainnet",
      chainId: 5_042,
      environment: "mainnet",
      nativeCurrency: { symbol: "USDC", decimals: 18 },
      testnet: false,
      transactionalAvailable: true,
      rpcUrl: MAINNET_RPC,
    });
    expect(assertFrontendTransactionsAvailable(config)).toBe(true);
  });

  it("never exposes the legacy swap executor V2 on Arc Mainnet", () => {
    const config =
      createFrontendTransactionalArcNetworkConfiguration("arc-mainnet");
    expect(config.contracts.wizpaySwapExecutorV2).toBeUndefined();
    expect(() =>
      validateFrontendArcNetworkOverrides(config, {
        NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS:
          "0x0000000000000000000000000000000000000000",
      }),
    ).toThrow("conflicts with WIZPAY_ARC_NETWORK.");
  });

  it("creates only the selected Mainnet explorer URL with an explicit chain", () => {
    const mainnet = resolveFrontendArcNetworkResourceState("arc-mainnet");
    expect(getExplorerTxUrlForNetwork(mainnet, TX_HASH, 5_042)).toBe(
      `${MAINNET_EXPLORER}/tx/${TX_HASH}`,
    );
    expect(getExplorerTxUrlForNetwork(mainnet, TX_HASH, undefined)).toBeNull();
    expect(getExplorerTxUrlForNetwork(mainnet, TX_HASH, 9_999)).toBeNull();
    expect(getExplorerTxUrlForNetwork(mainnet, "not-a-hash", 5_042)).toBeNull();
  });

  it.each([
    ["NEXT_PUBLIC_RPC_URL", "https://alternate.invalid"],
    ["NEXT_PUBLIC_CONTRACT_ADDRESS", MAINNET_EXECUTOR],
    ["NEXT_PUBLIC_WIZPAY_ADDRESS", MAINNET_EXECUTOR],
    ["NEXT_PUBLIC_ARC_USDC", MAINNET_EURC],
    ["NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS", MAINNET_WIZPAY],
  ])("rejects conflicting active override %s", (name, value) => {
    const config =
      createFrontendTransactionalArcNetworkConfiguration("arc-mainnet");
    expect(() =>
      validateFrontendArcNetworkOverrides(config, { [name]: value }),
    ).toThrow(`${name} conflicts with WIZPAY_ARC_NETWORK.`);
  });
});
