import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SwapProgress, getSwapProgressModel } from "./SwapProgress";

describe("SwapProgress", () => {
  it("omits External Wallet approval when allowance is sufficient", () => {
    const model = getSwapProgressModel({
      walletMode: "external",
      requestStatus: "signing",
      approvalRequired: false,
      failed: false,
    });

    expect(model.map((step) => step.id)).not.toContain("authorization");
    expect(model.find((step) => step.id === "signing")?.state).toBe("active");
  });

  it("shows token approval only when External Wallet approval is required", () => {
    render(
      <SwapProgress
        walletMode="external"
        tokenIn="USDC"
        tokenOut="EURC"
        amount="12.5"
        requestStatus="approving"
        approvalRequired={true}
        failure={null}
        onDismissFailure={vi.fn()}
      />,
    );

    expect(screen.getByText("Approving token").closest("li")).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.getByText("12.5 USDC")).toBeInTheDocument();
    expect(screen.getByText("External Wallet")).toBeInTheDocument();
    expect(screen.getByText("XyloNet · Arc Testnet")).toBeInTheDocument();
  });

  it("maps persisted App Wallet lifecycle state and exposes a safe failure reset", () => {
    const onDismissFailure = vi.fn();
    render(
      <SwapProgress
        walletMode="circle"
        tokenIn="USDC"
        tokenOut="EURC"
        amount="1"
        requestStatus="signing"
        lifecycleStage="swap_submitted"
        approvalRequired={true}
        failure="Transaction confirmation failed closed."
        onDismissFailure={onDismissFailure}
      />,
    );

    expect(screen.getByText("Confirming on Arc").closest("li")).toHaveAttribute(
      "data-state",
      "failed",
    );
    screen.getByRole("button", { name: "Review swap" }).click();
    expect(onDismissFailure).toHaveBeenCalledOnce();
  });
});
