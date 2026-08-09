import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { BackendApiError } from "@/lib/backend-api";
import {
  createAppWalletQuote,
  renderSwapScreen,
  resetSwapScreenMocks,
  swapScreenMocks,
} from "@/test/support/swap-screen";

function routeUnavailableError() {
  return new BackendApiError(
    "SwapKit has no USDC to EURC route for this amount. Try a smaller amount or select StableFX.",
    502,
    "SWAPKIT_ROUTE_UNAVAILABLE",
  );
}

function enterAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText("0.0"), {
    target: { value },
  });
}

async function previewQuote() {
  await waitFor(() =>
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalled(),
  );
}

describe("SwapScreen App Wallet SwapKit route unavailability", () => {
  beforeEach(() => {
    resetSwapScreenMocks();
  });

  it("shows the actionable SwapKit message instead of a generic failure", async () => {
    swapScreenMocks.appWallet.quote.mockRejectedValue(routeUnavailableError());
    renderSwapScreen();
    enterAmount("1");

    await previewQuote();

    expect(
      await screen.findByText(
        "SwapKit has no USDC → EURC route for this amount. Try a smaller amount or select StableFX.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps SwapKit selected and does not switch to StableFX", async () => {
    swapScreenMocks.appWallet.quote.mockRejectedValue(routeUnavailableError());
    renderSwapScreen();
    enterAmount("1");

    await previewQuote();
    await waitFor(() =>
      expect(swapScreenMocks.appWallet.quote).toHaveBeenCalled(),
    );

    expect(screen.getAllByText("SwapKit").length).toBeGreaterThan(0);
    expect(swapScreenMocks.appWallet.createOperation).not.toHaveBeenCalled();
    // Only the one explicitly requested provider was ever quoted.
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(1);
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "swapkit" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps the entered amount and direction editable after the failure", async () => {
    swapScreenMocks.appWallet.quote.mockRejectedValue(routeUnavailableError());
    renderSwapScreen();
    enterAmount("1");

    await previewQuote();
    await screen.findByText(/Try a smaller amount or select StableFX\./);

    expect(screen.getByPlaceholderText("0.0")).toHaveValue(1);
    expect(screen.getAllByRole("combobox")[0]).toHaveValue("USDC");
    expect(screen.getAllByRole("combobox")[1]).toHaveValue("EURC");
  });

  it("clears stale expected and minimum output after a failed quote", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValueOnce(
      createAppWalletQuote("swapkit", {
        expectedOutput: "8880000",
        minimumOutput: "8700000",
      }),
    );
    renderSwapScreen();
    enterAmount("1");
    await previewQuote();
    expect(
      await screen.findByText("8.88 EURC", { selector: "span.font-mono" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("8.7 EURC", { selector: "span.font-mono" }),
    ).toBeInTheDocument();

    swapScreenMocks.appWallet.quote.mockRejectedValue(routeUnavailableError());
    enterAmount("5");
    await previewQuote();
    await screen.findByText(/Try a smaller amount or select StableFX\./);

    expect(
      screen.queryByText("8.88 EURC", { selector: "span.font-mono" }),
    ).toBeNull();
    expect(
      screen.queryByText("8.7 EURC", { selector: "span.font-mono" }),
    ).toBeNull();
  });

  it("routes a threshold amount to StableFX after a SwapKit failure", async () => {
    swapScreenMocks.appWallet.quote.mockRejectedValueOnce(
      routeUnavailableError(),
    );
    renderSwapScreen();
    enterAmount("1");
    await previewQuote();
    await screen.findByText(/Try a smaller amount or select StableFX\./);

    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("stablefx"),
    );
    enterAmount("10");
    await previewQuote();

    await waitFor(() =>
      expect(swapScreenMocks.appWallet.quote).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: "stablefx" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.getAllByText("StableFX").length).toBeGreaterThan(0);
  });

  it("preserves the working EURC to USDC SwapKit quote", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit", {
        tokenIn: "EURC",
        tokenOut: "USDC",
        amountIn: "1000000",
        expectedOutput: "34960000",
        minimumOutput: "34260000",
      }),
    );
    renderSwapScreen();
    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "EURC" },
    });
    enterAmount("1");

    await previewQuote();

    await waitFor(() =>
      expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenIn: "EURC",
          tokenOut: "USDC",
          amountIn: "1000000",
          provider: "swapkit",
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      await screen.findByText("34.96 USDC", { selector: "span.font-mono" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("34.26 USDC", { selector: "span.font-mono" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Try a smaller amount or select StableFX\./),
    ).toBeNull();
  });

  it("keeps generic handling for unknown quote errors", async () => {
    swapScreenMocks.appWallet.quote.mockRejectedValue(
      new BackendApiError(
        "Circle Stablecoin Kits API returned 404.",
        502,
        "CIRCLE_STABLECOIN_API_FAILED",
      ),
    );
    renderSwapScreen();
    enterAmount("1");

    await previewQuote();

    expect(
      await screen.findByText("Circle Stablecoin Kits API returned 404."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Try a smaller amount or select StableFX\./),
    ).toBeNull();
  });
});
