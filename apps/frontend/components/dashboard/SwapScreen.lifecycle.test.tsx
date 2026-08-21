import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppWalletSwapOperationResponse } from "@/lib/app-wallet-swap-service";
import {
  createAppWalletOperation,
  renderSwapScreen,
  resetSwapScreenMocks,
  swapScreenMocks,
} from "@/test/support/swap-screen";

async function renderOperation(
  status: AppWalletSwapOperationResponse["status"],
  overrides: Partial<AppWalletSwapOperationResponse> = {},
) {
  swapScreenMocks.appWallet.createOperation.mockResolvedValue(
    createAppWalletOperation(status, overrides),
  );
  const view = renderSwapScreen();
  fireEvent.change(screen.getByPlaceholderText("0.0"), {
    target: { value: "10" },
  });
  await waitFor(() =>
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Confirm swap" }));
  await screen.findByRole("dialog");
  return view;
}

async function submitDeposit() {
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm swap" }));
  await waitFor(() =>
    expect(swapScreenMocks.appWallet.submitDeposit).toHaveBeenCalled(),
  );
}

describe("SwapScreen App Wallet lifecycle", () => {
  beforeEach(() => {
    resetSwapScreenMocks();
  });

  it("executes the Circle challenge before deposit submission", async () => {
    await renderOperation("awaiting_user_deposit");
    await submitDeposit();

    expect(
      swapScreenMocks.circle.executeChallenge.mock.invocationCallOrder[0],
    ).toBeLessThan(
      swapScreenMocks.appWallet.submitDeposit.mock.invocationCallOrder[0],
    );
  });

  it("attaches an optional deposit txHash only after deposit submission", async () => {
    const txHash = `0x${"a".repeat(64)}`;
    swapScreenMocks.circle.executeChallenge.mockResolvedValue({
      id: "circle-transaction-1",
      txHash,
    });
    await renderOperation("awaiting_user_deposit");
    await submitDeposit();

    expect(
      swapScreenMocks.appWallet.submitDeposit.mock.invocationCallOrder[0],
    ).toBeLessThan(
      swapScreenMocks.appWallet.attachDepositTxHash.mock.invocationCallOrder[0],
    );
    expect(swapScreenMocks.appWallet.attachDepositTxHash).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { depositTxHash: txHash },
    );
  });

  it("does not attach a txHash when Circle returns none", async () => {
    await renderOperation("awaiting_user_deposit");
    await submitDeposit();
    expect(
      swapScreenMocks.appWallet.attachDepositTxHash,
    ).not.toHaveBeenCalled();
  });

  it("preserves ten deposit-discovery attempts three seconds apart", async () => {
    swapScreenMocks.appWallet.resolveDepositTxHash.mockResolvedValue(
      createAppWalletOperation("deposit_submitted"),
    );
    await renderOperation("awaiting_user_deposit");
    vi.useFakeTimers();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm swap",
      }),
    );
    await act(async () => Promise.resolve());
    expect(
      swapScreenMocks.appWallet.resolveDepositTxHash,
    ).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(
      swapScreenMocks.appWallet.resolveDepositTxHash,
    ).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      swapScreenMocks.appWallet.resolveDepositTxHash,
    ).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(27_000);
    });
    expect(
      swapScreenMocks.appWallet.resolveDepositTxHash,
    ).toHaveBeenCalledTimes(10);
  });

  it("prevents concurrent duplicate manual execution", async () => {
    let resolveExecute!: (operation: AppWalletSwapOperationResponse) => void;
    swapScreenMocks.appWallet.executeOperation.mockImplementation(
      () =>
        new Promise<AppWalletSwapOperationResponse>((resolve) => {
          resolveExecute = resolve;
        }),
    );
    await renderOperation("execution_failed");
    const retry = screen.getByRole("button", { name: "Retry status check" });

    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(swapScreenMocks.appWallet.executeOperation).toHaveBeenCalledTimes(1);

    resolveExecute(createAppWalletOperation("completed"));
    await waitFor(() =>
      expect(screen.getByText("Swap completed")).toBeVisible(),
    );
  });

  it("retries observation after a transient GET error without financial resubmission", async () => {
    swapScreenMocks.appWallet.refundOperation.mockResolvedValue(
      createAppWalletOperation("refund_pending"),
    );
    swapScreenMocks.appWallet.getOperation
      .mockRejectedValueOnce(new Error("temporary observation failure"))
      .mockResolvedValueOnce(createAppWalletOperation("refunded"));
    await renderOperation("execution_recovery_required");
    await userEvent.click(
      screen.getByRole("button", { name: "Request refund" }),
    );
    await screen.findByText("Request deposit refund recovery?");
    const confirmation = screen.getAllByRole("dialog").at(-1)!;
    vi.useFakeTimers();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Request refund" }),
    );
    await act(async () => Promise.resolve());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(swapScreenMocks.appWallet.getOperation).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(swapScreenMocks.appWallet.getOperation).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(swapScreenMocks.appWallet.getOperation).toHaveBeenCalledTimes(2);
    expect(swapScreenMocks.appWallet.refundOperation).toHaveBeenCalledTimes(1);
    expect(swapScreenMocks.appWallet.executeOperation).not.toHaveBeenCalled();
  });

  it("clears the scheduled lifecycle timer on unmount", async () => {
    swapScreenMocks.appWallet.refundOperation.mockResolvedValue(
      createAppWalletOperation("refund_pending"),
    );
    const view = await renderOperation("execution_recovery_required");
    await userEvent.click(
      screen.getByRole("button", { name: "Request refund" }),
    );
    await screen.findByText("Request deposit refund recovery?");
    const confirmation = screen.getAllByRole("dialog").at(-1)!;
    vi.useFakeTimers();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Request refund" }),
    );
    await act(async () => Promise.resolve());

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(swapScreenMocks.appWallet.getOperation).not.toHaveBeenCalled();
  });

  it("preserves current reset behavior after terminal completion", async () => {
    await renderOperation("completed", { provider: "swapkit" });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByPlaceholderText("0.0")).toHaveValue(10);
    expect(screen.getAllByText("StableFX").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Confirm swap" })).toBeDisabled();
  });
});
