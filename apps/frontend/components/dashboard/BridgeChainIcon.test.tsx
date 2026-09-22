import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BridgeChainLabel, bridgeChainPresentation } from "./BridgeChainIcon";

const EXPECTED_CHAINS = [
  ["ARC-MAINNET", "Arc", "/networks/arc.svg"],
  ["ETH-MAINNET", "Ethereum", "/networks/ethereum.svg"],
  ["BASE-MAINNET", "Base", "/networks/base.svg"],
  ["ARB-MAINNET", "Arbitrum", "/networks/arbitrum.svg"],
  ["OP-MAINNET", "Optimism", "/networks/optimism.svg"],
  ["POLYGON-MAINNET", "Polygon", "/networks/polygon.svg"],
  ["AVAX-MAINNET", "Avalanche", "/networks/avalanche.svg"],
] as const;

describe("BridgeChainIcon", () => {
  it.each(EXPECTED_CHAINS)(
    "maps %s to its local official icon and label",
    (code, label, iconPath) => {
      expect(bridgeChainPresentation(code)).toEqual({ label, iconPath });
    },
  );

  it("renders the icon as decorative next to visible network text", () => {
    const { container } = render(<BridgeChainLabel chainCode="ARC-MAINNET" />);

    expect(screen.getByText("Arc")).toBeInTheDocument();
    expect(screen.queryByText("Arc (5042)")).not.toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    expect(container.querySelector("img")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
