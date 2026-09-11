import { describe, expect, it } from "vitest";

import {
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
  });

  it.each([undefined, "", " arc-testnet ", "ARC-TESTNET", "unknown"])(
    "rejects missing or inexact selectors: %p",
    (selector) => {
      expect(() =>
        createFrontendTransactionalArcNetworkConfiguration(selector),
      ).toThrow();
    },
  );

  it("recognizes Arc Mainnet but cannot create a transactional configuration", () => {
    const state = resolveFrontendArcNetworkResourceState("arc-mainnet");
    expect(state.key).toBe("arc-mainnet");
    expect(state.network.chainId).toBe(5_042);
    expect(state.uniswapSwapRouter02).toMatchObject({
      status: "published",
      executable: false,
    });
    expect(() =>
      requireFrontendTransactionalArcNetworkConfiguration(state),
    ).toThrow("OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE");
  });

  it("never imports Testnet active resources into Arc Mainnet", () => {
    const state = resolveFrontendArcNetworkResourceState("arc-mainnet");
    expect(state.rpc).not.toEqual(
      expect.objectContaining({ value: { url: TESTNET_RPC } }),
    );
    expect(state.explorer).not.toEqual(
      expect.objectContaining({ value: { baseUrl: TESTNET_EXPLORER } }),
    );
    expect(state.tokens.USDC).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_USDC } }),
    );
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

  it("builds a future Mainnet direct configuration with only the required contract", () => {
    const state = resolveFrontendArcNetworkResourceState("arc-mainnet");
    const available = <T>(value: T) => ({
      status: "available" as const,
      value,
    });
    const config = requireFrontendTransactionalArcNetworkConfiguration({
      ...state,
      rpc: available({ url: "https://mainnet.invalid" }),
      explorer: available({ baseUrl: "https://explorer.invalid" }),
      tokens: {
        USDC: available({
          symbol: "USDC",
          address: "0x123456789012345678901234567890123456789a",
          decimals: 6,
        }),
        EURC: available({
          symbol: "EURC",
          address: "0x12345678901234567890123456789012345689ab",
          decimals: 6,
        }),
      },
      contracts: {
        wizpay: available({
          contract: "WizPayMainnetV2",
          address: "0x1234567890123456789012345678901234569abc",
          deploymentSource:
            "packages/contracts/deployments/arc-mainnet-wizpay-v2.json",
        }),
        wizpaySwapExecutorV2: available({
          contract: "WizPaySwapExecutorV2",
          address: "0x123456789012345678901234567890123456abcd",
          deploymentSource: "forbidden-mainnet-swap.json",
        }),
      },
    });
    expect(config.tokens).not.toHaveProperty("EURC");
    expect(config.contracts).toEqual({
      wizpay: expect.objectContaining({ contract: "WizPayMainnetV2" }),
    });
    expect(() =>
      validateFrontendArcNetworkOverrides(config, {
        NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS:
          "0x123456789012345678901234567890123456abcd",
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
    expect(getExplorerTxUrlForNetwork(mainnet, TX_HASH, 5_042)).toBeNull();
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
