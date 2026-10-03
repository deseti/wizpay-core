import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletAuthProvider, useWalletAuth } from "./WalletAuthProvider";

const walletState = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  chainId: 5042,
  signMessage: vi.fn(),
  backendFetch: vi.fn(),
}));

vi.mock("@/lib/backend-api", () => ({
  backendFetch: walletState.backendFetch,
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
    useWalletClient: () => ({ data: { signMessage: walletState.signMessage } }),
  };
});

function Probe() {
  const auth = useWalletAuth();
  return (
    <>
      <div data-testid="session">{auth.sessionToken ?? "none"}</div>
      <div data-testid="state">{auth.state}</div>
      <button onClick={() => void auth.authenticate().catch(() => {})}>
        Authenticate
      </button>
    </>
  );
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
      <WalletAuthProvider>
        <Probe />
      </WalletAuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("session")).toHaveTextContent(
        "wallet-a-session",
      ),
    );
    walletState.address = "0x2222222222222222222222222222222222222222";
    view.rerender(
      <WalletAuthProvider>
        <Probe />
      </WalletAuthProvider>,
    );
    expect(screen.getByTestId("session")).toHaveTextContent("none");
  });

  it("rejected signing creates no session or verification request and permits a clean retry", async () => {
    walletState.backendFetch.mockResolvedValueOnce({
      challengeId: "synthetic-challenge",
      message: "Authentication only",
    });
    walletState.signMessage.mockRejectedValueOnce(
      new Error("User rejected signature"),
    );
    render(
      <WalletAuthProvider>
        <Probe />
      </WalletAuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }));
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("error"),
    );
    expect(screen.getByTestId("session")).toHaveTextContent("none");
    expect(window.sessionStorage.length).toBe(0);
    expect(walletState.backendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/wallets/auth/challenge",
    ]);
    walletState.backendFetch.mockResolvedValueOnce({
      challengeId: "retry-challenge",
      message: "Authentication only",
    });
    walletState.signMessage.mockResolvedValueOnce("0xsynthetic-auth-signature");
    walletState.backendFetch.mockResolvedValueOnce({
      address: walletState.address,
      chainId: 5042,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      sessionToken: "synthetic-session",
      userId: "synthetic-owner",
    });
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }));
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("authenticated"),
    );
    expect(walletState.signMessage).toHaveBeenCalledTimes(2);
    expect(walletState.backendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/wallets/auth/challenge",
      "/wallets/auth/challenge",
      "/wallets/auth/verify",
    ]);
  });

  it("wrong network does not request a challenge or wallet signature", async () => {
    walletState.chainId = 1;
    render(
      <WalletAuthProvider>
        <Probe />
      </WalletAuthProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("wrong_network");
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }));
    await waitFor(() => expect(walletState.signMessage).not.toHaveBeenCalled());
    expect(walletState.backendFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("session")).toHaveTextContent("none");
  });
});
