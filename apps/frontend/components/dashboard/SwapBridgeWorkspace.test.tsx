import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwapBridgeWorkspace, swapBridgeMode } from "./SwapBridgeWorkspace";

const navigation = vi.hoisted(() => ({
  pathname: "/swap",
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock("@/components/dashboard/SwapScreen", () => ({
  SwapScreen: () => <div>Swap execution surface</div>,
}));

vi.mock("@/components/dashboard/BridgeScreen", () => ({
  BridgeScreen: () => <div>Bridge execution surface</div>,
}));

describe("SwapBridgeWorkspace", () => {
  beforeEach(() => {
    navigation.pathname = "/swap";
    navigation.push.mockReset();
  });

  it("selects the route mode without combining execution screens", () => {
    expect(swapBridgeMode("/swap")).toBe("swap");
    expect(swapBridgeMode("/bridge")).toBe("bridge");
    expect(swapBridgeMode("/bridge/status")).toBe("bridge");
    render(<SwapBridgeWorkspace />);
    expect(screen.getByRole("tab", { name: "Swap" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Bridge" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByText("Swap execution surface")).toBeInTheDocument();
    expect(
      screen.queryByText("Bridge execution surface"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Bridge" }));
    expect(navigation.push).toHaveBeenCalledWith("/bridge");
    expect(screen.getByText("Swap execution surface")).toBeInTheDocument();
  });

  it("opens Bridge from the legacy bridge route", () => {
    navigation.pathname = "/bridge";
    render(<SwapBridgeWorkspace />);
    expect(screen.getByRole("tab", { name: "Bridge" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Bridge execution surface")).toBeInTheDocument();
    expect(
      screen.queryByText("Swap execution surface"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Swap" }));
    expect(navigation.push).toHaveBeenCalledWith("/swap");
  });
});
