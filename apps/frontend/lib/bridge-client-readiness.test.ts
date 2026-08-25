import { describe, expect, it, vi } from "vitest";
import { getBridgeTestnet } from "@wizpay/bridge-registry";
import {
  createBridgePublicClient,
  getBridgeReadinessError,
  resolveBridgeRpcUrl,
  switchBridgeWalletChain,
} from "./bridge-client-readiness";
import type { Address } from "viem";
import type { Connector } from "wagmi";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const arc = getBridgeTestnet("ARC-TESTNET");
const base = getBridgeTestnet("BASE-SEPOLIA");
const connector = {} as Connector;
const transport = {};
const walletClient = {
  account: { address: WALLET },
  transport,
};

function readyInputs() {
  return {
    walletAddress: WALLET,
    walletAccount: WALLET,
    connector,
    walletClient,
    connectorClient: { transport },
    source: arc,
    destination: base,
    sourceRpcUrl: arc.defaultRpcUrl,
    destinationRpcUrl: base.defaultRpcUrl,
    sourceChainId: arc.chainId,
    destinationChainId: base.chainId,
    sourceClient: createBridgePublicClient(arc),
    destinationClient: createBridgePublicClient(base),
  };
}

describe("bridge public client readiness", () => {
  it("creates independent Arc and Base Sepolia public clients from registry RPCs", () => {
    const sourceClient = createBridgePublicClient(arc, "https://rpc.test");
    const destinationClient = createBridgePublicClient(
      base,
      "https://rpc.base",
    );
    expect(sourceClient?.chain?.id).toBe(arc.chainId);
    expect(destinationClient?.chain?.id).toBe(base.chainId);
    expect(resolveBridgeRpcUrl(arc, "https://rpc.test")).toBe(
      "https://rpc.test",
    );
    expect(resolveBridgeRpcUrl(base, "https://rpc.base")).toBe(
      "https://rpc.base",
    );
  });

  it("accepts a connected Rabby-compatible injected wallet on the Arc source chain", () => {
    expect(getBridgeReadinessError(readyInputs())).toBeNull();
  });

  it.each([
    ["missing provider", { connectorClient: undefined }, "provider"],
    ["missing source registry", { source: undefined }, "source testnet"],
    [
      "missing destination registry",
      { destination: undefined },
      "destination testnet",
    ],
    ["missing source RPC", { sourceRpcUrl: undefined }, "source testnet RPC"],
    [
      "missing destination RPC",
      { destinationRpcUrl: undefined },
      "destination testnet RPC",
    ],
    [
      "missing source client",
      { sourceClient: undefined },
      "source public RPC client",
    ],
    [
      "missing destination client",
      { destinationClient: undefined },
      "destination public RPC client",
    ],
  ])(
    "identifies the exact missing dependency: %s",
    (_name, override, expected) => {
      expect(
        getBridgeReadinessError({ ...readyInputs(), ...override }),
      ).toContain(expected);
    },
  );

  it("identifies an account/provider mismatch without exposing provider details", () => {
    expect(
      getBridgeReadinessError({
        ...readyInputs(),
        walletAccount: "0x2222222222222222222222222222222222222222" as Address,
      }),
    ).toContain("does not match");
  });

  it("handles a wallet initially on the correct source chain", async () => {
    const switchChain = vi.fn().mockResolvedValue({ id: arc.chainId });
    await expect(
      switchBridgeWalletChain({
        targetChainId: arc.chainId,
        switchChain,
      }),
    ).resolves.toBe(arc.chainId);
    expect(switchChain).toHaveBeenCalledWith({ chainId: arc.chainId });
  });

  it("switches a wallet initially on another chain to the selected destination", async () => {
    const switchChain = vi.fn().mockResolvedValue({ id: base.chainId });
    await expect(
      switchBridgeWalletChain({
        targetChainId: base.chainId,
        switchChain,
      }),
    ).resolves.toBe(base.chainId);
  });

  it("rejects a failed chain switch precisely", async () => {
    await expect(
      switchBridgeWalletChain({
        targetChainId: base.chainId,
        switchChain: vi.fn().mockResolvedValue({ id: arc.chainId }),
      }),
    ).rejects.toThrow("required testnet");
  });
});
