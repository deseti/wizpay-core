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

async function chooseProvider(
  trigger: HTMLElement,
  name: "StableFX" | "SwapKit" | "XyloNet",
) {
  const value = {
    StableFX: "stablefx",
    SwapKit: "swapkit",
    XyloNet: "xylonet",
  }[name];

  await userEvent.selectOptions(trigger, value);
}

async function requestQuote() {
  fireEvent.change(screen.getByPlaceholderText("0.0"), {
    target: { value: "1" },
  });

  await userEvent.click(
    screen.getByRole("button", { name: "Preview quote" }),
  );

  await waitFor(() =>
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalled(),
  );
}

async function createOperation() {
  await requestQuote();

  await userEvent.click(
    screen.getByRole("button", { name: "Confirm swap" }),
  );

  await waitFor(() =>
    expect(swapScreenMocks.appWallet.createOperation).toHaveBeenCalled(),
  );
}

describe("SwapScreen App Wallet provider ownership", () => {
  beforeEach(() => {
    resetSwapScreenMocks();
  });

  it("shows backend default before explicit provider selection", () => {
    renderSwapScreen();

    const provider = screen.getAllByRole("combobox")[2];

    expect(provider).toHaveTextContent("Backend default");
    expect(
      screen.queryByText("StableFX", { selector: "span.font-mono" }),
    ).toBeNull();
  });

  it("offers only StableFX and SwapKit for App Wallet", async () => {
    renderSwapScreen();

    const provider = screen.getAllByRole("combobox")[2];
    const options = within(provider).getAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual([
      "Backend default",
      "StableFX",
      "SwapKit",
    ]);
    expect(within(provider).queryByText("XyloNet")).toBeNull();
  });

  it("keeps External Wallet provider state independent", async () => {
    const view = renderSwapScreen();

    await chooseProvider(screen.getAllByRole("combobox")[2], "SwapKit");
    view.unmount();

    swapScreenMocks.wallet.mode = "external";

    const externalView = renderSwapScreen();
    const externalProvider = screen.getAllByRole("combobox")[2];

    expect(externalProvider).toHaveTextContent("StableFX Official");

    await chooseProvider(externalProvider, "XyloNet");

    expect(externalProvider).toHaveTextContent("XyloNet");

    externalView.unmount();

    expect(swapScreenMocks.appWallet.quote).not.toHaveBeenCalled();
    expect(swapScreenMocks.external.quote).not.toHaveBeenCalled();
  });

  it("sends an explicit App Wallet provider in the quote request", async () => {
    renderSwapScreen();

    await chooseProvider(screen.getAllByRole("combobox")[2], "SwapKit");

    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    await requestQuote();

    expect(swapScreenMocks.appWallet.quote).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "swapkit" }),
    );
  });

  it("adopts the provider returned by a backend-default quote", async () => {
    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    renderSwapScreen();

    await requestQuote();

    expect(screen.getAllByRole("combobox")[2]).toHaveTextContent("SwapKit");
  });

  it("invalidates an incompatible quote when the provider changes", async () => {
    renderSwapScreen();

    await requestQuote();

    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(1);

    await chooseProvider(screen.getAllByRole("combobox")[2], "SwapKit");

    swapScreenMocks.appWallet.quote.mockResolvedValue(
      createAppWalletQuote("swapkit"),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Confirm swap" }),
    );

    await waitFor(() =>
      expect(swapScreenMocks.appWallet.quote).toHaveBeenCalledTimes(3),
    );

    expect(swapScreenMocks.appWallet.quote).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "swapkit" }),
    );

    expect(swapScreenMocks.appWallet.quote).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ provider: "swapkit" }),
    );

    expect(swapScreenMocks.appWallet.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "swapkit" }),
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

    const provider = screen.getAllByRole("combobox")[2];

    expect(provider).toBeDisabled();
    expect(provider).toHaveTextContent("SwapKit");
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

    await chooseProvider(screen.getAllByRole("combobox")[2], "SwapKit");

    await createOperation();

    const provider = screen.getAllByRole("combobox")[2];

    expect(provider).toBeDisabled();
    expect(provider).toHaveValue("");
    expect(
      within(await screen.findByRole("dialog")).getByText("Unavailable"),
    ).toBeInTheDocument();
  });
});