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
const TESTNET_RPC = "https://rpc.testnet.arc.io";
const TESTNET_EXPLORER = "https://testnet.arcscan.app";
const TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const TESTNET_EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const TESTNET_WIZPAY = "0x87ACE45582f45cC81AC1E627E875AE84cbd75946";
const TESTNET_EXECUTOR = "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed";

describe("frontend Arc network configuration", () => {
  it("creates the exact immutable Arc Testnet transactional configuration", () => {
    const state = resolveFrontendArcNetworkResourceState("arc-testnet");
    const config =
      createFrontendTransactionalArcNetworkConfiguration("arc-testnet");
    expect(config).toMatchObject({
      key: "arc-testnet",
      chainId: 5_042_002,
      rpcUrl: TESTNET_RPC,
      explorerBaseUrl: TESTNET_EXPLORER,
      tokens: {
        USDC: { address: TESTNET_USDC },
        EURC: { address: TESTNET_EURC },
      },
      contracts: {
        wizpay: { address: TESTNET_WIZPAY },
        wizpaySwapExecutorV2: { address: TESTNET_EXECUTOR },
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.contracts)).toBe(true);
    expect(state.mainnetUniswapV4).toBeNull();
  });

  it.each([undefined, "", " arc-testnet ", "ARC-TESTNET", "unknown"])(
    "rejects missing or inexact selectors: %p",
    (selector) => {
      expect(() =>
        createFrontendTransactionalArcNetworkConfiguration(selector),
      ).toThrow();
    },
  );

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
      rpcUrl: "https://rpc.mainnet.arc.io",
      explorerBaseUrl: "https://explorer.arc.io",
      transactionalAvailable: true,
      tokens: {
        USDC: { address: TESTNET_USDC },
        EURC: { address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1" },
      },
      contracts: {
        wizpay: {
          contract: "WizPayPayrollMainnet",
          address: "0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34",
        },
        wizpaySwapExecutorMainnet: {
          address: "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
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
      rpcUrl: "https://rpc.mainnet.arc.io",
    });
    expect(assertFrontendTransactionsAvailable(config)).toBe(true);
  });

  it("never imports Testnet active resources into Arc Mainnet", () => {
    const state = resolveFrontendArcNetworkResourceState("arc-mainnet");
    expect(state.rpc).not.toEqual(
      expect.objectContaining({ value: { url: TESTNET_RPC } }),
    );
    expect(state.explorer).not.toEqual(
      expect.objectContaining({ value: { baseUrl: TESTNET_EXPLORER } }),
    );
    expect(state.tokens.USDC).toMatchObject({
      status: "available",
      value: { address: TESTNET_USDC },
    });
    expect(state.tokens.EURC).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_EURC } }),
    );
    expect(state.contracts.wizpay).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_WIZPAY } }),
    );
    expect(state.contracts.wizpaySwapExecutorV2).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_EXECUTOR } }),
    );
  });

  it("never exposes the Testnet swap executor V2 on Arc Mainnet", () => {
    const config =
      createFrontendTransactionalArcNetworkConfiguration("arc-mainnet");
    expect(config.contracts.wizpaySwapExecutorV2).toBeUndefined();
    expect(() =>
      validateFrontendArcNetworkOverrides(config, {
        NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS: TESTNET_EXECUTOR,
      }),
    ).toThrow("unavailable for the selected network");
  });

  it("creates only the selected Testnet explorer URL with an explicit chain", () => {
    const testnet = resolveFrontendArcNetworkResourceState("arc-testnet");
    const mainnet = resolveFrontendArcNetworkResourceState("arc-mainnet");
    expect(getExplorerTxUrlForNetwork(testnet, TX_HASH, 5_042_002)).toBe(
      `${TESTNET_EXPLORER}/tx/${TX_HASH}`,
    );
    expect(getExplorerTxUrlForNetwork(testnet, TX_HASH, undefined)).toBeNull();
    expect(getExplorerTxUrlForNetwork(mainnet, TX_HASH, 5_042)).toBe(
      `https://explorer.arc.io/tx/${TX_HASH}`,
    );
    expect(getExplorerTxUrlForNetwork(mainnet, TX_HASH, 5_042_002)).toBeNull();
  });

  it.each([
    ["NEXT_PUBLIC_RPC_URL", "https://alternate.invalid"],
    ["NEXT_PUBLIC_CONTRACT_ADDRESS", TESTNET_EXECUTOR],
    ["NEXT_PUBLIC_WIZPAY_ADDRESS", TESTNET_EXECUTOR],
    ["NEXT_PUBLIC_ARC_USDC", TESTNET_EURC],
    ["NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS", TESTNET_WIZPAY],
  ])("rejects conflicting active override %s", (name, value) => {
    const config =
      createFrontendTransactionalArcNetworkConfiguration("arc-testnet");
    expect(() =>
      validateFrontendArcNetworkOverrides(config, { [name]: value }),
    ).toThrow(`${name} conflicts with WIZPAY_ARC_NETWORK.`);
  });
});
