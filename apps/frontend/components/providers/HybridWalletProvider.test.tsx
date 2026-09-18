import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HybridWalletProvider,
  useHybridWallet,
} from "@/components/providers/HybridWalletProvider";
import { WALLET_MODE_STORAGE_KEY } from "@/lib/wallet-mode";

const wallet = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as
    `0x${string}` | undefined,
  chainId: 5_042_002,
  connected: true,
  connectorName: "Rabby",
  connectError: null as Error | null,
  disconnect: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: wallet.address,
    connector: wallet.connected ? { name: wallet.connectorName } : undefined,
    isConnected: wallet.connected,
  }),
  useBalance: () => ({ data: { formatted: "10" } }),
  useChainId: () => wallet.chainId,
  useConnect: () => ({
    connectors: [{ id: "injected" }],
    error: wallet.connectError,
  }),
  useDisconnect: () => ({ disconnect: wallet.disconnect }),
}));
vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => ({
    arcWallet: null,
    authenticated: false,
    primaryWallet: null,
    ready: false,
    sepoliaWallet: null,
  }),
}));
vi.mock("@/lib/wagmi", () => ({
  arcTestnet: { id: 5_042_002 },
  ethereumSepolia: { id: 11_155_111 },
  CHAIN_NAME_BY_ID: {
    5_042_002: "Arc Testnet",
    11_155_111: "Ethereum Sepolia",
  },
  SUPPORTED_CHAIN_IDS: new Set([5_042_002, 11_155_111]),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <HybridWalletProvider>{children}</HybridWalletProvider>;
}

describe("HybridWalletProvider external wallet lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(WALLET_MODE_STORAGE_KEY, "external");
    wallet.address = "0x1111111111111111111111111111111111111111";
    wallet.chainId = 5_042_002;
    wallet.connected = true;
    wallet.connectorName = "Rabby";
    wallet.connectError = null;
    wallet.disconnect.mockReset();
  });

  it("reacts to disconnect and reconnect without substituting an identity", () => {
    const { result, rerender } = renderHook(() => useHybridWallet(), {
      wrapper,
    });
    expect(result.current.externalWalletAddress).toBe(wallet.address);
    expect(result.current.isExternalConnected).toBe(true);

    wallet.address = undefined;
    wallet.connected = false;
    rerender();
    expect(result.current.externalWalletAddress).toBeUndefined();
    expect(result.current.isExternalConnected).toBe(false);
    expect(result.current.activeWalletAddress).toBeUndefined();

    wallet.address = "0x2222222222222222222222222222222222222222";
    wallet.connected = true;
    wallet.connectorName = "MetaMask";
    rerender();
    expect(result.current.externalWalletAddress).toBe(wallet.address);
    expect(result.current.externalConnectorName).toBe("MetaMask");
  });

  it("updates the session identity on account and chain changes", () => {
    const { result, rerender } = renderHook(() => useHybridWallet(), {
      wrapper,
    });
    const initialSession = result.current.sessionKey;

    wallet.address = "0x3333333333333333333333333333333333333333";
    rerender();
    expect(result.current.sessionKey).not.toBe(initialSession);
    expect(result.current.activeWalletAddress).toBe(wallet.address);

    const accountSession = result.current.sessionKey;
    wallet.chainId = 1;
    rerender();
    expect(result.current.sessionKey).not.toBe(accountSession);
    expect(result.current.isExternalChainSupported).toBe(false);
    expect(result.current.requiresArcSwitch).toBe(true);
  });
});
