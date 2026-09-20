import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CircleDisabledProvider } from "@/components/providers/CircleDisabledProvider";
import { ExternalWalletProvider } from "@/components/providers/ExternalWalletProvider";
import { ConnectWalletCard } from "@/components/dashboard/ConnectWalletCard";
import { WALLET_MODE_STORAGE_KEY } from "@/lib/wallet-mode";

vi.mock("@/lib/active-arc-network", () => ({
  ACTIVE_ARC_NETWORK: {
    key: "arc-mainnet",
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

// If any Mainnet-mounted component touches Circle provider state, this mock
// throws and the test fails. ExternalWalletProvider and ConnectWalletCard
// must render without it.
vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => {
    throw new Error("Circle provider state must not be read on Mainnet.");
  },
}));

vi.mock("@/lib/wagmi", () => ({
  activeArcChain: { id: 5_042 },
  arcTestnet: { id: 5_042 },
  CHAIN_NAME_BY_ID: { 5_042: "Arc Mainnet" },
  SUPPORTED_CHAIN_IDS: new Set([5_042]),
}));

vi.mock("@reown/appkit/react", () => ({
  useAppKit: () => ({ open: vi.fn() }),
}));

import { useHybridWallet } from "@/components/providers/HybridWalletProvider";

function MainnetTree({ children }: { children: ReactNode }) {
  return (
    <CircleDisabledProvider>
      <ExternalWalletProvider>{children}</ExternalWalletProvider>
    </CircleDisabledProvider>
  );
}

function Probe() {
  const hybrid = useHybridWallet();
  return (
    <div
      data-testid="probe"
      data-mode={hybrid.walletMode}
      data-active={hybrid.activeWalletAddress ?? "none"}
      data-circle-connected={String(hybrid.isCircleConnected)}
      data-external-connected={String(hybrid.isExternalConnected)}
      data-ready={String(hybrid.isReady)}
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

  it("resolves external-only mode without reading Circle provider state", () => {
    render(
      <MainnetTree>
        <Probe />
      </MainnetTree>,
    );
    const probe = screen.getByTestId("probe");
    expect(probe.dataset.mode).toBe("external");
    expect(probe.dataset.active).toBe(wallet.address);
    expect(probe.dataset.circleConnected).toBe("false");
    expect(probe.dataset.externalConnected).toBe("true");
    expect(probe.dataset.ready).toBe("true");
  });

  it("refuses to activate Circle mode", async () => {
    localStorage.setItem(WALLET_MODE_STORAGE_KEY, "circle");
    const user = userEvent.setup();
    function ModeSwitcher() {
      const { setWalletMode, walletMode } = useHybridWallet();
      return (
        <button onClick={() => setWalletMode("circle")}>
          mode:{walletMode}
        </button>
      );
    }
    render(
      <MainnetTree>
        <ModeSwitcher />
      </MainnetTree>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("mode:external");
    await user.click(button);
    expect(button).toHaveTextContent("mode:external");
  });

  it("shows the Reown CTA and no Circle login CTA", () => {
    render(
      <MainnetTree>
        <ConnectWalletCard />
      </MainnetTree>,
    );
    expect(
      screen.getByRole("button", { name: /connect external wallet/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in with circle/i }),
    ).toBeNull();
    expect(screen.queryByText(/circle app id/i)).toBeNull();
  });

  it("does not fall back to Circle when the external wallet disconnects", () => {
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
    expect(probe.dataset.circleConnected).toBe("false");
    expect(probe.dataset.externalConnected).toBe("false");
  });

  it("exposes inert Circle fields through the hybrid context", () => {
    render(
      <MainnetTree>
        <Probe />
      </MainnetTree>,
    );
    // Circle login fields exist on the shared context but are inert constants.
    function CircleFields() {
      const hybrid = useHybridWallet();
      return (
        <div
          data-testid="circle-fields"
          data-ready={String(hybrid.circleReady)}
          data-error={hybrid.circleAuthError ?? "none"}
        />
      );
    }
    render(
      <MainnetTree>
        <CircleFields />
      </MainnetTree>,
    );
    const fields = screen.getByTestId("circle-fields");
    expect(fields.dataset.ready).toBe("false");
    expect(fields.dataset.error).toBe("none");
  });
});

describe("Arc Mainnet provider-tree structure", () => {
  const appProviders = readFileSync(
    resolve(process.cwd(), "app/providers.tsx"),
    "utf8",
  );
  const branchStart = appProviders.indexOf("if (IS_ARC_MAINNET)");
  const branchEnd = appProviders.indexOf("\n  }\n", branchStart);
  const mainnetBranch = appProviders.slice(branchStart, branchEnd);

  it("mounts the external-only boundary on the Mainnet branch", () => {
    expect(appProviders).toContain("IS_ARC_MAINNET");
    expect(mainnetBranch).toContain("ExternalWalletProvider");
    expect(mainnetBranch).toContain("CircleDisabledProvider");
  });

  it("mounts no Circle SDK provider or API proxy on the Mainnet branch", () => {
    expect(mainnetBranch).not.toContain("CircleWalletProvider");
    expect(mainnetBranch).not.toContain("CircleApiProxyProvider");
  });

  it("keeps the hybrid Circle tree for Arc Testnet", () => {
    expect(appProviders).toContain("CircleWalletProvider");
    expect(appProviders).toContain("HybridWalletProvider");
    expect(appProviders).toContain("CircleApiProxyProvider");
  });

  it("ConnectWalletCard no longer depends on Circle auth state", () => {
    const card = readFileSync(
      resolve(process.cwd(), "components/dashboard/ConnectWalletCard.tsx"),
      "utf8",
    );
    expect(card).not.toContain("useCircleWallet");
    expect(card).not.toContain("CircleWalletProvider");
    expect(card).toContain("circleLogin");
  });

  it("CircleDisabledProvider contains no Circle runtime imports", () => {
    const stub = readFileSync(
      resolve(process.cwd(), "components/providers/CircleDisabledProvider.tsx"),
      "utf8",
    );
    expect(stub).not.toMatch(/from "@\/lib\/circle-/);
    expect(stub).not.toContain("./circle/");
    // Only a type-only import (erased at compile time) may reference Circle.
    expect(stub).not.toMatch(
      /^import \{(?![^}]*\btype\b)[^}]*\} from "@\/services\/circle-auth\.service"/m,
    );
    expect(stub).toContain("import type");
  });

  it("ExternalWalletProvider never reads Circle state", () => {
    const provider = readFileSync(
      resolve(process.cwd(), "components/providers/ExternalWalletProvider.tsx"),
      "utf8",
    );
    expect(provider).not.toContain("useCircleWallet");
    expect(provider).not.toContain("CircleWalletProvider");
    expect(provider).toContain('walletMode: "external"');
  });
});
