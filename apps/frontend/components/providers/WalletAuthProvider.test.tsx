import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletAuthProvider, useWalletAuth } from "./WalletAuthProvider";

const walletState = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  chainId: 5042,
}));

vi.mock("@/components/providers/external-wallet-context", () => ({
  useExternalWallet: () => ({
    activeWalletAddress: walletState.address,
    activeWalletChainId: walletState.chainId,
  }),
}));
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useWalletClient: () => ({ data: { signMessage: vi.fn() } }),
  };
});

function Probe() {
  const auth = useWalletAuth();
  return <div data-testid="session">{auth.sessionToken ?? "none"}</div>;
}

describe("WalletAuthProvider wallet isolation", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    walletState.address = "0x1111111111111111111111111111111111111111";
    walletState.chainId = 5042;
  });

  it("immediately stops exposing wallet A session when the connected wallet changes", async () => {
    window.sessionStorage.setItem(
      `wizpay.wallet-auth.v1:${walletState.address}`,
      JSON.stringify({
        address: walletState.address,
        chainId: 5042,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        sessionToken: "wallet-a-session",
        userId: "owner-a",
      }),
    );
    const view = render(
      <WalletAuthProvider><Probe /></WalletAuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("wallet-a-session"));
    walletState.address = "0x2222222222222222222222222222222222222222";
    view.rerender(<WalletAuthProvider><Probe /></WalletAuthProvider>);
    expect(screen.getByTestId("session")).toHaveTextContent("none");
  });
});
