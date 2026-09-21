import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SwapProgress, getSwapProgressModel } from "./SwapProgress";

describe("SwapProgress", () => {
  it("omits the approval step when allowance is sufficient", () => {
    const model = getSwapProgressModel({
      requestStatus: "signing",
      approvalRequired: false,
      failed: false,
    });

    expect(model.map((step) => step.id)).not.toContain("approval");
    expect(model.find((step) => step.id === "signing")?.state).toBe("active");
  });

  it("shows token approval only when wallet approval is required", () => {
    render(
      <SwapProgress
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
    expect(screen.getByText("Arc Mainnet · chain 5042")).toBeInTheDocument();
  });

  it("marks the failed Mainnet step and exposes a safe failure reset", () => {
    const onDismissFailure = vi.fn();
    render(
      <SwapProgress
        tokenIn="USDC"
        tokenOut="EURC"
        amount="1"
        requestStatus="signing"
        approvalRequired={true}
        failure="Transaction confirmation failed closed."
        onDismissFailure={onDismissFailure}
      />,
    );

    expect(
      screen.getByText("Signing transaction").closest("li"),
    ).toHaveAttribute("data-state", "failed");
    screen.getByRole("button", { name: "Review swap" }).click();
    expect(onDismissFailure).toHaveBeenCalledOnce();
  });
});
