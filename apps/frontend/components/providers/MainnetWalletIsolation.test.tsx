import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalWalletProvider } from "@/components/providers/ExternalWalletProvider";
import { ConnectWalletCard } from "@/components/dashboard/ConnectWalletCard";
import {
  DEFAULT_WALLET_MODE,
  getWalletModeLabel,
  parseWalletMode,
} from "@/lib/wallet-mode";

vi.mock("@/lib/active-arc-network", () => ({
  ACTIVE_ARC_NETWORK: {
    key: "arc-mainnet",
    name: "Arc Mainnet",
    chainId: 5_042,
    contracts: {},
    tokens: {},
  },
}));

const wallet = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as
    `0x${string}` | undefined,
  chainId: 5_042,
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

vi.mock("@/lib/wagmi", () => ({
  activeArcChain: { id: 5_042, name: "Arc Mainnet" },
  CHAIN_NAME_BY_ID: { 5_042: "Arc Mainnet" },
  SUPPORTED_CHAIN_IDS: new Set([5_042]),
}));

vi.mock("@reown/appkit/react", () => ({
  useAppKit: () => ({ open: vi.fn() }),
}));

import { useExternalWallet } from "@/components/providers/external-wallet-context";

function MainnetTree({ children }: { children: ReactNode }) {
  return <ExternalWalletProvider>{children}</ExternalWalletProvider>;
}

function Probe() {
  const external = useExternalWallet();
  return (
    <div
      data-testid="probe"
      data-mode={external.walletMode}
      data-active={external.activeWalletAddress ?? "none"}
      data-external-connected={String(external.isExternalConnected)}
      data-ready={String(external.isReady)}
    />
  );
}

describe("Arc Mainnet external-wallet-only isolation", () => {
  beforeEach(() => {
    localStorage.clear();
    wallet.address = "0x1111111111111111111111111111111111111111";
    wallet.chainId = 5_042;
    wallet.connected = true;
    wallet.connectorName = "Rabby";
    wallet.connectError = null;
    wallet.disconnect.mockReset();
  });

  it("resolves external-only mode from the connected wallet", () => {
    render(
      <MainnetTree>
        <Probe />
      </MainnetTree>,
    );
    const probe = screen.getByTestId("probe");
    expect(probe.dataset.mode).toBe("external");
    expect(probe.dataset.active).toBe(wallet.address);
    expect(probe.dataset.externalConnected).toBe("true");
    expect(probe.dataset.ready).toBe("true");
  });

  it("keeps wallet mode external regardless of stored legacy mode", () => {
    localStorage.setItem("wizpay.wallet.mode", "circle");
    render(
      <MainnetTree>
        <Probe />
      </MainnetTree>,
    );
    expect(screen.getByTestId("probe").dataset.mode).toBe("external");
    expect(parseWalletMode("circle")).toBe("external");
    expect(DEFAULT_WALLET_MODE).toBe("external");
    expect(getWalletModeLabel("external")).toBe("External Wallet");
  });

  it("shows the Reown CTA and no legacy login CTA", () => {
    render(
      <MainnetTree>
        <ConnectWalletCard />
      </MainnetTree>,
    );
    expect(
      screen.getByRole("button", { name: /connect external wallet/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in/i }),
    ).toBeNull();
  });

  it("does not fall back to another wallet when the external wallet disconnects", () => {
    wallet.address = undefined;
    wallet.connected = false;
    render(
      <MainnetTree>
        <Probe />
      </MainnetTree>,
    );
    const probe = screen.getByTestId("probe");
    expect(probe.dataset.active).toBe("none");
    expect(probe.dataset.mode).toBe("external");
    expect(probe.dataset.externalConnected).toBe("false");
  });
});

describe("Arc Mainnet provider-tree structure", () => {
  const appProviders = readFileSync(
    resolve(process.cwd(), "app/providers.tsx"),
    "utf8",
  );

  it("mounts the external-only provider tree", () => {
    expect(appProviders).toContain("ExternalWalletProvider");
    expect(appProviders).toContain("CapabilityProvider");
    expect(appProviders).toContain("WagmiProvider");
    expect(appProviders).toContain("Wallet configuration unavailable");
  });

  it("mounts no legacy wallet provider on any branch", () => {
    expect(appProviders.toLowerCase()).not.toContain("circle");
    expect(appProviders).not.toContain("HybridWalletProvider");
    expect(appProviders).not.toContain("WalletModeToggle");
  });

  it("ConnectWalletCard depends only on external wallet state", () => {
    const card = readFileSync(
      resolve(process.cwd(), "components/dashboard/ConnectWalletCard.tsx"),
      "utf8",
    );
    expect(card).toContain("useExternalWallet");
    expect(card.toLowerCase()).not.toContain("circle");
    expect(card).toContain(
      "Arc Mainnet uses connected external wallets only",
    );
  });

  it("ExternalWalletProvider never reads legacy wallet state", () => {
    const provider = readFileSync(
      resolve(process.cwd(), "components/providers/ExternalWalletProvider.tsx"),
      "utf8",
    );
    expect(provider.toLowerCase()).not.toContain("circle");
    expect(provider).not.toContain("HybridWallet");
    expect(provider).toContain('walletMode: "external"');
  });
});
