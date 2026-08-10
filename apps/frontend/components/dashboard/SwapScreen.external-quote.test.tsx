import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderSwapScreen,
  resetSwapScreenMocks,
  swapScreenMocks,
} from "@/test/support/swap-screen";

describe("SwapScreen External Wallet automatic quotes", () => {
  function createQuote(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      amountIn: "1250000",
      chain: "ARC-TESTNET",
      expectedOutput: "1237500",
      fromAddress: "0x1111111111111111111111111111111111111111",
      provider: "stablefx",
      raw: {},
      tokenIn: "USDC",
      tokenOut: "EURC",
      toAddress: "0x1111111111111111111111111111111111111111",
      ...overrides,
    };
  }

  beforeEach(() => {
    resetSwapScreenMocks();
    swapScreenMocks.wallet.mode = "external";
    swapScreenMocks.external.quote.mockResolvedValue(createQuote());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes the selected provider quote after the debounce", async () => {
    renderSwapScreen();

    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "1.25" },
    });
    expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();

    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(1),
    );

    expect(swapScreenMocks.external.quote).toHaveBeenCalledWith(
      {
        amountIn: "1250000",
        chain: "ARC-TESTNET",
        fromAddress: "0x1111111111111111111111111111111111111111",
        provider: "stablefx",
        slippageBps: 200,
        tokenIn: "USDC",
        tokenOut: "EURC",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByRole("button", { name: "Preview quote" })).toBeNull();
    expect(await screen.findByText("Quote updated automatically")).toBeInTheDocument();
  });

  it.each(["", "0", "-1", "-"]) (
    "does not quote an invalid amount: %s",
    async (amount) => {
      vi.useFakeTimers();
      renderSwapScreen();
      fireEvent.change(screen.getByPlaceholderText("0.0"), {
        target: { value: amount },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(swapScreenMocks.external.quote).not.toHaveBeenCalled();
    },
  );

  it("does not quote an equal-token pair", async () => {
    renderSwapScreen();
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "EURC" } });
    fireEvent.change(selects[1], { target: { value: "EURC" } });
    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "1.25" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(swapScreenMocks.external.quote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
  });

  it("clears the quote and refreshes when amount, pair, provider, wallet, or chain changes", async () => {
    renderSwapScreen();
    const amount = screen.getByPlaceholderText("0.0");
    const selects = screen.getAllByRole("combobox");

    fireEvent.change(amount, { target: { value: "1.25" } });
    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(1),
    );

    fireEvent.change(amount, { target: { value: "2" } });
    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(2),
    );

    fireEvent.change(selects[0], { target: { value: "EURC" } });
    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(3),
    );

    fireEvent.change(selects[2], { target: { value: "xylonet" } });
    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(4),
    );

    swapScreenMocks.wallet.address =
      "0x2222222222222222222222222222222222222222";
    fireEvent.change(amount, { target: { value: "2.1" } });
    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(5),
    );

    swapScreenMocks.walletClient.chain = { id: 1 };
    fireEvent.change(amount, { target: { value: "2.2" } });
    expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
    expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(5);
  });

  it("ignores stale success and stale errors after the newest request", async () => {
    vi.useFakeTimers();
    const requests: Array<{
      reject: (error: Error) => void;
      resolve: (quote: Record<string, unknown>) => void;
    }> = [];
    swapScreenMocks.external.quote.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          requests.push({ reject, resolve });
        }),
    );
    renderSwapScreen();
    const amount = screen.getByPlaceholderText("0.0");

    fireEvent.change(amount, { target: { value: "1" } });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    fireEvent.change(amount, { target: { value: "2" } });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(requests).toHaveLength(2);

    requests[1].resolve(createQuote({ amountIn: "2000000", expectedOutput: "2" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("0.000002 EURC").length).toBeGreaterThan(0);

    requests[0].reject(new Error("stale failure"));
    await act(async () => Promise.resolve());
    expect(screen.queryByText("stale failure")).toBeNull();
  });

  it("does not show an error for an aborted request", async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    swapScreenMocks.external.quote
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => (rejectFirst = reject)),
      )
      .mockResolvedValueOnce(createQuote({ amountIn: "2000000" }));
    renderSwapScreen();
    const amount = screen.getByPlaceholderText("0.0");

    fireEvent.change(amount, { target: { value: "1" } });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    fireEvent.change(amount, { target: { value: "2" } });
    rejectFirst(new Error("aborted request"));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => Promise.resolve());
    expect(screen.queryByText("aborted request")).toBeNull();
  });

  it("does not enable confirmation for an expired or mismatched quote", async () => {
    swapScreenMocks.external.quote.mockResolvedValue(
      createQuote({ expiresAt: "2000-01-01T00:00:00.000Z" }),
    );
    renderSwapScreen();
    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "1.25" },
    });
    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
    expect(swapScreenMocks.external.prepare).not.toHaveBeenCalled();
    expect(swapScreenMocks.external.createTrade).not.toHaveBeenCalled();
    expect(swapScreenMocks.appWallet.createOperation).not.toHaveBeenCalled();
  });

  it("does not quote without an external wallet or when the chain is wrong", async () => {
    swapScreenMocks.wallet.address = undefined;
    renderSwapScreen();
    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "1.25" },
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(swapScreenMocks.external.quote).not.toHaveBeenCalled();

    swapScreenMocks.wallet.address =
      "0x1111111111111111111111111111111111111111";
    swapScreenMocks.walletClient.chain = { id: 1 };
    renderSwapScreen();
    fireEvent.change(screen.getAllByPlaceholderText("0.0")[1] ?? screen.getByPlaceholderText("0.0"), {
      target: { value: "1.25" },
    });
    expect(swapScreenMocks.external.quote).not.toHaveBeenCalled();
  });

  it("rejects a quote that does not identify the selected provider", async () => {
    swapScreenMocks.external.quote.mockResolvedValue(
      createQuote({ provider: undefined }),
    );
    renderSwapScreen();
    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "1.25" },
    });
    await waitFor(() =>
      expect(swapScreenMocks.external.quote).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
    expect(screen.queryByText("Quote updated automatically")).toBeNull();
  });
});
