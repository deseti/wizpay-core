import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarWalletSummary } from "./SidebarWalletSummary";

const state = vi.hoisted(() => ({
  activeWalletAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69" as
    | `0x${string}`
    | undefined,
  activeWalletLabel: "External Wallet (MetaMask)",
  toast: vi.fn(),
}));

vi.mock("@/components/providers/external-wallet-context", () => ({
  useExternalWallet: () => ({
    activeWalletAddress: state.activeWalletAddress,
    activeWalletLabel: state.activeWalletLabel,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));

describe("SidebarWalletSummary", () => {
  beforeEach(() => {
    state.activeWalletAddress =
      "0x32F251fc36A1174901124589EAC2d4E391816F69";
    state.activeWalletLabel = "External Wallet (MetaMask)";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders the connected external wallet with its address and Mainnet scope", () => {
    render(<SidebarWalletSummary />);
    expect(screen.getByText("Connected Wallet")).toBeInTheDocument();
    expect(
      screen.getByText("External Wallet (MetaMask)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Arc Mainnet \(chain 5042\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy External Wallet (MetaMask)" }),
    ).toHaveAttribute("title", state.activeWalletAddress);
  });

  it("copies the full canonical address even though the visible value is truncated", () => {
    render(<SidebarWalletSummary />);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy External Wallet (MetaMask)" }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      state.activeWalletAddress,
    );
  });

  it("renders nothing when no external wallet is connected", () => {
    state.activeWalletAddress = undefined;
    const { container } = render(<SidebarWalletSummary />);
    expect(container.firstChild).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("button", { name: /Copy / }),
    ).not.toBeInTheDocument();
  });
});
