import { describe, expect, it } from "vitest";

import { BackendApiError } from "@/lib/backend-api";

import { getAppWalletQuoteErrorMessage } from "./app-wallet-swap-view-model";

const USDC_TO_EURC = { tokenIn: "USDC", tokenOut: "EURC" } as const;
const EURC_TO_USDC = { tokenIn: "EURC", tokenOut: "USDC" } as const;

function routeUnavailableError() {
  return new BackendApiError(
    "SwapKit has no USDC to EURC route for this amount. Try a smaller amount or select StableFX.",
    502,
    "SWAPKIT_ROUTE_UNAVAILABLE",
  );
}

describe("getAppWalletQuoteErrorMessage", () => {
  it("returns an actionable message for the known route-unavailable code", () => {
    expect(
      getAppWalletQuoteErrorMessage(routeUnavailableError(), USDC_TO_EURC),
    ).toBe(
      "SwapKit has no USDC → EURC route for this amount. Try a smaller amount or select StableFX.",
    );
  });

  it("reflects the direction actually requested", () => {
    expect(
      getAppWalletQuoteErrorMessage(routeUnavailableError(), EURC_TO_USDC),
    ).toContain("EURC → USDC");
  });

  it("never suggests a generic infrastructure failure for the known case", () => {
    const message = getAppWalletQuoteErrorMessage(
      routeUnavailableError(),
      USDC_TO_EURC,
    );

    expect(message.toLowerCase()).not.toContain("circle");
    expect(message.toLowerCase()).not.toContain("backend");
    expect(message.toLowerCase()).not.toContain("502");
  });

  it("keeps generic handling for other backend error codes", () => {
    const error = new BackendApiError(
      "Circle Stablecoin Kits API returned 404.",
      502,
      "CIRCLE_STABLECOIN_API_FAILED",
    );

    expect(getAppWalletQuoteErrorMessage(error, USDC_TO_EURC)).toBe(
      "Circle Stablecoin Kits API returned 404.",
    );
  });

  it("keeps generic handling for errors without a code", () => {
    expect(
      getAppWalletQuoteErrorMessage(new Error("network down"), USDC_TO_EURC),
    ).toBe("network down");
  });
});
