import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAppWalletQuote,
  renderSwapScreen,
  resetSwapScreenMocks,
  swapScreenMocks,
} from "@/test/support/swap-screen";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

function amountInput() {
  return screen.getByPlaceholderText("0.0");
}

async function triggerAutoQuote(value = "1") {
  const requestCount = swapScreenMocks.appWallet.quote.mock.calls.length + 1;
  fireEvent.change(amountInput(), { target: { value } });
  await waitFor(() =>
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(requestCount),
  );
}

describe("SwapScreen App Wallet automatic quote characterization", () => {
  beforeEach(() => {
    resetSwapScreenMocks();
  });

  it("does not request a quote for an empty amount", async () => {
    renderSwapScreen();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(swapScreenMocks.appWallet.quote).not.toHaveBeenCalled();
  });

  it("requests the exact automatically routed payload after the 500ms debounce", async () => {
    renderSwapScreen();

    await triggerAutoQuote("1.25");

    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(1);
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledWith(
      {
        amountIn: "1250000",
        chain: "ARC-TESTNET",
        fromAddress: WALLET_ADDRESS,
        provider: "swapkit",
        tokenIn: "USDC",
        tokenOut: "EURC",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByRole("button", { name: "Preview quote" })).toBeNull();
  });

  it.each([
    ["1", "SwapKit"],
    ["9.999999", "SwapKit"],
    ["10", "StableFX"],
  ] as const)("auto-selects the provider for %s", async (amount, label) => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote(label === "SwapKit" ? "swapkit" : "stablefx", {
        amountIn:
          amount === "10"
            ? "10000000"
            : amount === "9.999999"
              ? "9999999"
              : "1000000",
      }),
    );
    renderSwapScreen();
    await triggerAutoQuote(amount);
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText("Auto-selected")).toBeInTheDocument();
  });

  it("maps expected output, minimum output, provider, and expiry from a successful quote", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit", {
        expectedOutput: "8.88",
        minimumOutput: "8.70",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    renderSwapScreen();

    await triggerAutoQuote("1");

    expect(
      await screen.findByText("8.88 EURC", { selector: "span.font-mono" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Minimum output").parentElement).toHaveTextContent(
      "8.70 EURC",
    );
    expect(screen.getAllByText("SwapKit").length).toBeGreaterThan(0);
    expect(screen.getByText("Quote expiry").parentElement).toHaveTextContent(
      /\d/,
    );
  });

  it("refreshes after an amount change and does not duplicate confirmation quoting", async () => {
    swapScreenMocks.appWallet.quote.mockImplementation(async (request) =>
      createAppWalletQuote(
        request.amountIn === "2000000" ? "swapkit" : "swapkit",
        { amountIn: request.amountIn },
      ),
    );
    renderSwapScreen();
    await triggerAutoQuote("1");
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(1);

    await triggerAutoQuote("2");
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole("button", { name: "Confirm swap" }));
    await waitFor(() =>
      expect(swapScreenMocks.appWallet.createOperation).toHaveBeenCalledTimes(
        1,
      ),
    );
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(2);
  });

  it("clears the previous quote immediately while a changed form is loading", async () => {
    let resolveQuote!: (quote: ReturnType<typeof createAppWalletQuote>) => void;
    swapScreenMocks.appWallet.quote.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuote = resolve;
        }),
    );
    renderSwapScreen();
    fireEvent.change(amountInput(), { target: { value: "1" } });

    await waitFor(() =>
      expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(1),
    );
    resolveQuote(createAppWalletQuote("swapkit"));
    await act(async () => Promise.resolve());
    expect((await screen.findAllByText("0.99 EURC")).length).toBeGreaterThan(0);

    fireEvent.change(amountInput(), { target: { value: "2" } });
    expect(screen.queryByText("0.99 EURC")).toBeNull();
  });

  it("lets the latest request win and ignores the older response", async () => {
    vi.useFakeTimers();
    const requests: Array<{
      resolve: (quote: ReturnType<typeof createAppWalletQuote>) => void;
    }> = [];
    swapScreenMocks.appWallet.quote.mockImplementation(
      () =>
        new Promise((resolve) => {
          requests.push({ resolve });
        }),
    );
    renderSwapScreen();

    fireEvent.change(amountInput(), { target: { value: "1" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.change(amountInput(), { target: { value: "2" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(requests).toHaveLength(2);
    requests[1].resolve(
      createAppWalletQuote("swapkit", {
        amountIn: "2000000",
        expectedOutput: "2000000",
      }),
    );
    requests[0].resolve(
      createAppWalletQuote("swapkit", {
        amountIn: "1000000",
        expectedOutput: "1000000",
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("2 EURC").length).toBeGreaterThan(0);
    expect(screen.queryByText("1 EURC")).toBeNull();
    vi.useRealTimers();
  });

  it("rejects an expired quote and blocks confirmation", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit", {
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    renderSwapScreen();

    await triggerAutoQuote("1");

    expect(screen.getByRole("button", { name: "Confirm swap" })).toBeDisabled();
    expect(swapScreenMocks.appWallet.createOperation).not.toHaveBeenCalled();
  });
});
