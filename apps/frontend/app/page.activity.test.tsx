import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UnifiedHistoryItem } from "@/lib/types";
import { RecentActivity } from "./page";

function activity(
  overrides: Partial<UnifiedHistoryItem> & Pick<UnifiedHistoryItem, "type">,
): UnifiedHistoryItem {
  return {
    txHash: `0x${"a".repeat(64)}`,
    blockNumber: 0n,
    timestampMs: Date.parse("2026-09-22T00:00:00Z"),
    status: "completed",
    direction: "outgoing",
    ...overrides,
  };
}

describe("Home Recent Activity states", () => {
  it("renders persisted non-empty activity", () => {
    render(
      <RecentActivity
        items={[{
          id: "activity-1",
          type: "send",
          txHash: `0x${"a".repeat(64)}`,
          blockNumber: 0n,
          timestampMs: Date.parse("2026-09-22T00:00:00Z"),
          status: "completed",
          direction: "outgoing",
          tokenSymbol: "USDC",
          amountDisplay: "10000",
        }]}
        isLoading={false}
        authRequired={false}
        error={null}
        onAuthenticate={vi.fn()}
      />,
    );
    expect(screen.getByText("Send")).toBeInTheDocument();
    expect(screen.queryByText("No Activity Yet")).not.toBeInTheDocument();
  });

  it("shows empty only for a genuine empty account and distinguishes errors", () => {
    const authenticate = vi.fn();
    const view = render(
      <RecentActivity items={[]} isLoading={false} authRequired={false} error={null} onAuthenticate={authenticate} />,
    );
    expect(screen.getByText("No Activity Yet")).toBeInTheDocument();
    view.rerender(
      <RecentActivity items={[]} isLoading={false} authRequired error={null} onAuthenticate={authenticate} />,
    );
    expect(screen.getByText("Authenticate your wallet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Authenticate wallet" }));
    expect(authenticate).toHaveBeenCalled();
    view.rerender(
      <RecentActivity items={[]} isLoading={false} authRequired={false} authError="Signature rejected" error={null} onAuthenticate={authenticate} />,
    );
    expect(screen.getByText("Wallet authentication failed")).toBeInTheDocument();
    expect(screen.getByText("Signature rejected")).toBeInTheDocument();
    expect(screen.queryByText("No Activity Yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Activity unavailable")).not.toBeInTheDocument();
    view.rerender(
      <RecentActivity items={[]} isLoading={false} authRequired={false} error="Backend unavailable" onAuthenticate={authenticate} />,
    );
    expect(screen.getByText("Activity unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No Activity Yet")).not.toBeInTheDocument();
  });

  it("formats raw USDC and EURC base units with token decimals and no trailing zeros", () => {
    const view = render(
      <RecentActivity
        items={[activity({ id: "swap-cent", type: "swap", tokenSymbol: "USDC", amountDisplay: "10000" })]}
        isLoading={false}
        authRequired={false}
        error={null}
        onAuthenticate={vi.fn()}
      />,
    );
    expect(screen.getByText("0.01 USDC")).toBeInTheDocument();
    expect(screen.queryByText("10000 USDC")).not.toBeInTheDocument();

    view.rerender(
      <RecentActivity
        items={[activity({ id: "swap-one", type: "swap", tokenSymbol: "USDC", amountDisplay: "1000000" })]}
        isLoading={false}
        authRequired={false}
        error={null}
        onAuthenticate={vi.fn()}
      />,
    );
    expect(screen.getByText("1 USDC")).toBeInTheDocument();
    expect(screen.queryByText("1.00 USDC")).not.toBeInTheDocument();
    expect(screen.queryByText("1.000000 USDC")).not.toBeInTheDocument();

    view.rerender(
      <RecentActivity
        items={[activity({ id: "swap-eurc", type: "swap", tokenSymbol: "EURC", amountDisplay: "8700" })]}
        isLoading={false}
        authRequired={false}
        error={null}
        onAuthenticate={vi.fn()}
      />,
    );
    expect(screen.getByText("0.0087 EURC")).toBeInTheDocument();

    view.rerender(
      <RecentActivity
        items={[activity({ id: "eurc-unit", type: "swap", tokenSymbol: "EURC", amountDisplay: "1" })]}
        isLoading={false}
        authRequired={false}
        error={null}
        onAuthenticate={vi.fn()}
      />,
    );
    expect(screen.getByText("0.000001 EURC")).toBeInTheDocument();
  });

  it("shows same-token payroll and keeps mixed-token payroll split by token", () => {
    const view = render(
      <RecentActivity
        items={[activity({
          id: "payroll-usdc",
          type: "payroll",
          tokenSymbol: "USDC",
          amountDisplay: "30000",
          tokenTotals: { USDC: "30000" },
        })]}
        isLoading={false}
        authRequired={false}
        error={null}
        onAuthenticate={vi.fn()}
      />,
    );
    expect(screen.getByText("0.03 USDC")).toBeInTheDocument();
    expect(screen.queryByText("— Token")).not.toBeInTheDocument();
    expect(screen.queryByText("30000 USDC")).not.toBeInTheDocument();

    view.rerender(
      <RecentActivity
        items={[activity({
          id: "payroll-mixed",
          type: "payroll",
          tokenTotals: { USDC: "20000", EURC: "10000" },
        })]}
        isLoading={false}
        authRequired={false}
        error={null}
        onAuthenticate={vi.fn()}
      />,
    );
    expect(screen.getByText("0.02 USDC · 0.01 EURC")).toBeInTheDocument();
    expect(screen.queryByText("0.03 USDC")).not.toBeInTheDocument();
    expect(screen.queryByText("— Token")).not.toBeInTheDocument();
    expect(screen.queryByText("Token")).not.toBeInTheDocument();
  });
});
