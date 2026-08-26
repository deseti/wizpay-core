import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarWalletSummary } from "./SidebarWalletSummary";

const state = vi.hoisted(() => ({
  walletMode: "circle" as "circle" | "external",
  activeAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
  arcAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
  sepoliaAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
  toast: vi.fn(),
}));

vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => ({
    arcWallet: state.arcAddress ? { address: state.arcAddress } : null,
    primaryWallet: state.arcAddress ? { address: state.arcAddress } : null,
    sepoliaWallet: state.sepoliaAddress ? { address: state.sepoliaAddress } : null,
  }),
}));
vi.mock("@/hooks/useSmartWalletAddress", () => ({
  useSmartWalletAddress: () => ({
    smartWalletAddress: state.activeAddress,
    isLoadingSmartWalletAddress: false,
    walletLabel: "External Wallet (MetaMask)",
    walletMode: state.walletMode,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));

describe("SidebarWalletSummary", () => {
  beforeEach(() => {
    state.walletMode = "circle";
    state.activeAddress = "0x32F251fc36A1174901124589EAC2d4E391816F69";
    state.arcAddress = state.activeAddress;
    state.sepoliaAddress = state.activeAddress;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders exactly one canonical EVM Address and no network or Solana cards", () => {
    render(<SidebarWalletSummary />);
    expect(screen.getAllByText("EVM Address")).toHaveLength(1);
    expect(screen.queryByText("Arc Testnet")).not.toBeInTheDocument();
    expect(screen.queryByText("Ethereum Sepolia")).not.toBeInTheDocument();
    expect(screen.queryByText(/Solana/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy EVM Address" })).toHaveAttribute("title", state.activeAddress);
  });

  it("copies the full canonical address even though the visible value is truncated", () => {
    render(<SidebarWalletSummary />);
    fireEvent.click(screen.getByRole("button", { name: "Copy EVM Address" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(state.activeAddress);
  });

  it("preserves the connected External Wallet presentation", () => {
    state.walletMode = "external";
    render(<SidebarWalletSummary />);
    expect(screen.getByText("External Wallet (MetaMask)")).toBeInTheDocument();
    expect(screen.queryByText("EVM Address")).not.toBeInTheDocument();
  });

  it("fails closed instead of silently choosing a mismatched EVM address", () => {
    state.sepoliaAddress = "0x1111111111111111111111111111111111111111";
    render(<SidebarWalletSummary />);
    expect(screen.queryByText("EVM Address")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("EVM addresses do not match");
  });
});
