import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBridgeTestnet } from "@wizpay/bridge-registry";
import type { Address, Hex } from "viem";

import { ExternalBridgePanel } from "./ExternalBridgePanel";
import { fetchIrisMessages } from "@/lib/cctp-v2";

const state = vi.hoisted(() => ({
  connectedAddress: undefined as Address | undefined,
  hash: `0x${"ab".repeat(32)}` as Hex,
  fetchIrisMessages: vi.fn(),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useAccount: () => ({ address: state.connectedAddress }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWalletClient: () => ({ data: undefined }),
}));

vi.mock("@/lib/bridge-client-readiness", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/bridge-client-readiness")
  >();
  const client = {
    readContract: vi.fn().mockResolvedValue(10_000_000n),
  };
  return {
    ...actual,
    createBridgePublicClient: () => client,
    createBridgePublicClients: () => [client],
    resolveBridgeRpcUrl: () => "https://rpc.example.test",
  };
});

vi.mock("@/lib/cctp-fee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cctp-fee")>();
  return {
    ...actual,
    createCctpFeeRequestCoordinator: () => ({
      cancel: vi.fn(),
      run: vi.fn().mockResolvedValue({
        state: "current",
        result: { maxFee: 0n },
      }),
    }),
  };
});

vi.mock("@/lib/cctp-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cctp-v2")>();
  const source = getBridgeTestnet("ARC-TESTNET");
  const destination = getBridgeTestnet("BASE-SEPOLIA");
  return {
    ...actual,
    fetchIrisMessages: state.fetchIrisMessages,
    readDirectBridgeRecovery: () => ({
      cctpVersion: 2 as const,
      sourceChainId: source.chainId,
      sourceDomain: source.cctpDomain,
      destinationChainId: destination.chainId,
      destinationDomain: destination.cctpDomain,
      sourceTransactionHash: state.hash,
      walletAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
      createdAt: "2026-08-25T00:00:00.000Z",
      amountUnits: "10000000",
    }),
  };
});

describe("ExternalBridgePanel pending recovery", () => {
  beforeEach(() => {
    state.connectedAddress = undefined;
    state.fetchIrisMessages.mockResolvedValue({ state: "pending", messages: [] });
  });

  it("keeps a confirmed burn active while Iris is pending without a wallet", async () => {
    render(
      <ExternalBridgePanel walletAddress="0x32F251fc36A1174901124589EAC2d4E391816F69" />,
    );

    expect(
      await screen.findByRole("region", { name: "Bridge in progress" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Waiting for Circle attestation")).toBeInTheDocument();
    expect(screen.queryByText("idle")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchIrisMessages).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Authorize source transfer" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Complete mint on/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps a temporary Iris timeout amber and does not reset to idle", async () => {
    state.fetchIrisMessages.mockRejectedValueOnce(
      new Error("Circle Iris request timed out."),
    );
    render(
      <ExternalBridgePanel walletAddress="0x32F251fc36A1174901124589EAC2d4E391816F69" />,
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("timed out"),
    );
    expect(screen.getByText("Waiting for Circle attestation")).toBeInTheDocument();
    expect(screen.queryByText("idle")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
