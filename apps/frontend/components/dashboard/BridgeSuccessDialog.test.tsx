import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BridgeSuccessDialog } from "./BridgeSuccessDialog";

describe("BridgeSuccessDialog", () => {
  it("renders the strictly verified bridge success details and actions", () => {
    const onDone = vi.fn();
    const onStartAnother = vi.fn();
    render(
      <BridgeSuccessDialog
        open
        sourceNetwork="Arc Testnet"
        destinationNetwork="Ethereum Sepolia"
        amount="10"
        token="USDC"
        recipient="0x32F251fc36A1174901124589EAC2d4E391816F69"
        sourceTransactionUrl="https://testnet.arcscan.app/tx/0xsource"
        destinationTransactionUrl="https://sepolia.etherscan.io/tx/0xdestination"
        onDone={onDone}
        onStartAnother={onStartAnother}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Bridge completed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Arc Testnet → Ethereum Sepolia"),
    ).toBeInTheDocument();
    expect(screen.getByText("10 USDC")).toBeInTheDocument();
    expect(
      screen.getByText("0x32F251fc36A1174901124589EAC2d4E391816F69"),
    ).toBeInTheDocument();
    const explorerActions = screen.getAllByRole("link", {
      name: /View on explorer/,
    });
    expect(explorerActions).toHaveLength(2);
    expect(explorerActions[0]).toHaveAttribute(
      "href",
      "https://testnet.arcscan.app/tx/0xsource",
    );
    expect(explorerActions[1]).toHaveAttribute(
      "href",
      "https://sepolia.etherscan.io/tx/0xdestination",
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Start another bridge" }),
    );
    expect(onDone).toHaveBeenCalledOnce();
    expect(onStartAnother).toHaveBeenCalledOnce();
  });
});
