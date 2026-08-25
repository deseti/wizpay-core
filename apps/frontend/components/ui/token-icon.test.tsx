import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS } from "@/lib/wizpay";
import { TokenIcon } from "./token-icon";

describe("TokenIcon", () => {
  it("renders a local canonical image and keeps fixed geometry", () => {
    const { container } = render(<TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={SUPPORTED_TOKENS.USDC.address} symbol="FAKE" size={32} decorative={false} />);
    expect(screen.getByRole("img", { name: /usd coin token/i })).toHaveStyle({ width: "32px", height: "32px", minWidth: "32px", minHeight: "32px" });
    const image = container.querySelector("img");
    expect(new URL(image?.getAttribute("src") ?? "", window.location.href).pathname).toBe("/tokens/usdc.png");
    expect(image).toHaveAttribute("width", "32");
    expect(image).toHaveAttribute("height", "32");
    expect(image).toHaveStyle({ width: "32px", height: "32px", objectFit: "contain", opacity: "1", filter: "none" });
    expect(image?.className).not.toMatch(/grayscale|opacity-|blur|filter/);
  });

  it("renders canonical EURC from its address, not the supplied symbol", () => {
    const { container } = render(<TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={SUPPORTED_TOKENS.EURC.address} symbol="USDC" />);
    expect(new URL(container.querySelector("img")?.getAttribute("src") ?? "", window.location.href).pathname).toBe("/tokens/eurc.png");
  });

  it("resets a prior image error when the resolved source changes", () => {
    const { container, rerender } = render(<TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={SUPPORTED_TOKENS.USDC.address} symbol="USDC" />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("USDC")).toBeInTheDocument();
    rerender(<TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={SUPPORTED_TOKENS.EURC.address} symbol="EURC" />);
    expect(new URL(container.querySelector("img")?.getAttribute("src") ?? "", window.location.href).pathname).toBe("/tokens/eurc.png");
    expect(screen.queryByText("EURC")).not.toBeInTheDocument();
  });

  it("falls back to address-derived initials after an image error", () => {
    const { container } = render(<TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={SUPPORTED_TOKENS.EURC.address} symbol="USDC" size={24} />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("EURC")).toBeInTheDocument();
    expect(container.firstChild).toHaveStyle({ width: "24px", height: "24px" });
  });
  it("uses a deterministic fallback for an unknown address", () => {
    render(<TokenIcon chainId={ARC_TESTNET_CHAIN_ID} address={`0x${"1".repeat(40)}`} symbol="ABC" />);
    expect(screen.getByText("ABC")).toBeInTheDocument();
  });
});
