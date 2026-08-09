import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createAppWalletOperation,
  createAppWalletQuote,
  renderSwapScreen,
  resetSwapScreenMocks,
  swapScreenMocks,
} from "@/test/support/swap-screen";

async function requestQuote() {
  fireEvent.change(screen.getByPlaceholderText("0.0"), {
    target: { value: "1" },
  });

  await waitFor(() =>
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalled(),
  );
}

async function createOperation() {
  await requestQuote();

  await userEvent.click(screen.getByRole("button", { name: "Confirm swap" }));

  await waitFor(() =>
    expect(swapScreenMocks.appWallet.createOperation).toHaveBeenCalled(),
  );
}

describe("SwapScreen App Wallet provider ownership", () => {
  beforeEach(() => {
    resetSwapScreenMocks();
  });

  it("shows automatic App Wallet provider selection", () => {
    renderSwapScreen();
    expect(screen.getByText("Auto-selected")).toBeInTheDocument();
    expect(
      screen.queryByText("StableFX", { selector: "span.font-mono" }),
    ).toBeNull();
  });

  it("does not expose a manual App Wallet provider selector", async () => {
    renderSwapScreen();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.queryByText("XyloNet")).toBeNull();
  });

  it("keeps External Wallet provider state independent", async () => {
    const view = renderSwapScreen();

    view.unmount();

    swapScreenMocks.wallet.mode = "external";

    const externalView = renderSwapScreen();
    const externalProvider = screen.getAllByRole("combobox")[2];

    expect(externalProvider).toHaveTextContent("StableFX Official");

    await userEvent.selectOptions(externalProvider, "xylonet");

    expect(externalProvider).toHaveTextContent("XyloNet");

    externalView.unmount();

    expect(swapScreenMocks.appWallet.quote).not.toHaveBeenCalled();
    expect(swapScreenMocks.external.quote).not.toHaveBeenCalled();
  });

  it("sends the automatically resolved App Wallet provider in the quote request", async () => {
    renderSwapScreen();

    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    await requestQuote();

    expect(swapScreenMocks.appWallet.quote).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "swapkit" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("adopts the provider returned by a backend-default quote", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    renderSwapScreen();

    await requestQuote();

    expect(screen.getAllByText("SwapKit").length).toBeGreaterThan(0);
  });

  it("invalidates the old quote when automatic routing changes", async () => {
    renderSwapScreen();

    await requestQuote();

    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "10" },
    });

    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("stablefx", { amountIn: "10000000" }),
    );

    await waitFor(() =>
      expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(2),
    );

    expect(swapScreenMocks.appWallet.quote).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "stablefx" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(swapScreenMocks.appWallet.createOperation).not.toHaveBeenCalled();
    await screen.findByText("Quote updated automatically");
    await userEvent.click(screen.getByRole("button", { name: "Confirm swap" }));
    expect(swapScreenMocks.appWallet.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "stablefx" }),
    );
  });

  it("creates an operation with the provider on the valid quote", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    swapScreenMocks.appWallet.createOperation.mockResolvedValue(
      createAppWalletOperation("awaiting_user_deposit", {
        provider: "swapkit",
      }),
    );

    renderSwapScreen();

    await createOperation();

    expect(swapScreenMocks.appWallet.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "swapkit" }),
    );
  });

  it("uses operation.provider as authoritative and locks the selector", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    swapScreenMocks.appWallet.createOperation.mockResolvedValue(
      createAppWalletOperation("awaiting_user_deposit", {
        provider: "swapkit",
      }),
    );

    renderSwapScreen();

    await createOperation();

    expect(screen.getAllByText("SwapKit").length).toBeGreaterThan(0);
    expect(
      within(await screen.findByRole("dialog")).getByText("SwapKit"),
    ).toBeInTheDocument();
  });

  it("does not let a legacy operation with missing provider inherit the current selector", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    swapScreenMocks.appWallet.createOperation.mockResolvedValue(
      createAppWalletOperation("awaiting_user_deposit", {
        provider: undefined,
      }),
    );

    renderSwapScreen();

    await createOperation();
    expect(
      within(await screen.findByRole("dialog")).getByText("Unavailable"),
    ).toBeInTheDocument();
  });
});
