import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CircleDisabledProvider } from "@/components/providers/CircleDisabledProvider";
import { useCircleWallet } from "@/components/providers/CircleWalletProvider";

vi.mock("@/lib/wagmi", () => ({
  activeArcChain: { id: 5_042 },
  arcTestnet: { id: 5_042 },
  CHAIN_NAME_BY_ID: { 5_042: "Arc Mainnet" },
  SUPPORTED_CHAIN_IDS: new Set([5_042]),
}));

function CircleProbe() {
  const circle = useCircleWallet();
  return (
    <div
      data-testid="circle-probe"
      data-authenticated={String(circle.authenticated)}
      data-ready={String(circle.ready)}
      data-token={circle.userToken ?? "none"}
    >
      <button
        onClick={() =>
          circle.executeChallenge("challenge-id").then(
            () => {},
            (error: unknown) => {
              (window as { __circleError?: string }).__circleError =
                error instanceof Error ? error.message : String(error);
            },
          )
        }
      >
        execute
      </button>
    </div>
  );
}

describe("CircleDisabledProvider", () => {
  it("exposes inert state and rejects challenge execution", async () => {
    const user = (
      await import("@testing-library/user-event")
    ).userEvent.setup();
    render(
      <CircleDisabledProvider>
        <CircleProbe />
      </CircleDisabledProvider>,
    );
    const probe = screen.getByTestId("circle-probe");
    expect(probe.dataset.authenticated).toBe("false");
    expect(probe.dataset.ready).toBe("false");
    expect(probe.dataset.token).toBe("none");

    await user.click(screen.getByRole("button", { name: "execute" }));
    expect((window as { __circleError?: string }).__circleError).toMatch(
      /unavailable on Arc Mainnet/,
    );
    delete (window as { __circleError?: string }).__circleError;
  });

  it("mounts no login modal and login is a safe no-op", () => {
    function LoginProbe() {
      const circle = useCircleWallet();
      circle.login();
      circle.logout();
      circle.closeLogin();
      return null;
    }
    render(
      <CircleDisabledProvider>
        <LoginProbe />
      </CircleDisabledProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
