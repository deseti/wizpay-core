import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SwapSuccessDialog } from "./SwapSuccessDialog";

const result = {
  inputAmount: "1",
  inputToken: "USDC",
  outputAmount: "0.95",
  outputToken: "EURC",
  walletMode: "External Wallet" as const,
  network: "Arc Testnet",
  transactionHash: `0x${"ab".repeat(32)}`,
  explorerUrl: `https://testnet.arcscan.app/tx/0x${"ab".repeat(32)}`,
};

describe("SwapSuccessDialog", () => {
  it("renders verified amounts, wallet mode, network, hash, and explorer action", () => {
    render(
      <SwapSuccessDialog
        open
        result={result}
        onDone={vi.fn()}
        onStartAnother={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Swap completed" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 USDC")).toBeInTheDocument();
    expect(screen.getByText("0.95 EURC")).toBeInTheDocument();
    const usdcIcon = document.querySelector('[data-token-icon="USDC"]');
    const eurcIcon = document.querySelector('[data-token-icon="EURC"]');
    expect(usdcIcon).toHaveStyle({ width: "24px", height: "24px" });
    expect(eurcIcon).toHaveStyle({ width: "24px", height: "24px" });
    expect(new URL(usdcIcon?.querySelector("img")?.getAttribute("src") ?? "", window.location.href).pathname).toBe("/tokens/usdc.png");
    expect(new URL(eurcIcon?.querySelector("img")?.getAttribute("src") ?? "", window.location.href).pathname).toBe("/tokens/eurc.png");
    expect(screen.getByText("External Wallet")).toBeInTheDocument();
    expect(screen.getByText("Arc Testnet")).toBeInTheDocument();
    expect(screen.getByText(result.transactionHash)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on explorer/ })).toHaveAttribute(
      "href",
      result.explorerUrl,
    );
  });

  it("supports Done and Start another swap actions", () => {
    const onDone = vi.fn();
    const onStartAnother = vi.fn();
    render(
      <SwapSuccessDialog
        open
        result={result}
        onDone={onDone}
        onStartAnother={onStartAnother}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Start another swap" }),
    );
    expect(onDone).toHaveBeenCalledOnce();
    expect(onStartAnother).toHaveBeenCalledOnce();
  });
});
