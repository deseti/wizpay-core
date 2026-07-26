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
  renderSwapScreen();
  fireEvent.change(screen.getByPlaceholderText("0.0"), {
    target: { value: "1" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Preview quote" }));
  await waitFor(() =>
    expect(swapScreenMocks.appWallet.quote).toHaveBeenCalled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Confirm swap" }));
  return screen.findByRole("dialog");
}

function findRefundAction() {
  return screen.queryByRole("button", {
    name: /^(Request refund|Continue refund recovery|Check refund status)$/,
  });
}

async function openRefundConfirmation() {
  const action = findRefundAction();
  expect(action).not.toBeNull();
  await userEvent.click(action!);
  await screen.findByText("Request deposit refund recovery?");
  return screen.getAllByRole("dialog").at(-1)!;
}

describe("SwapScreen refund and recovery", () => {
  beforeEach(() => {
    resetSwapScreenMocks();
  });

  it.each([
    ["execution_recovery_required", "Request refund"],
    ["execution_failed", "Request refund"],
    ["refund_pending", "Continue refund recovery"],
    ["refund_submitted", "Check refund status"],
  ] as const)("offers refund action for %s", async (status, label) => {
    await renderOperation(status);
    expect(screen.getByRole("button", { name: label })).toBeEnabled();
  });

  it.each([
    "awaiting_user_deposit",
    "deposit_submitted",
    "deposit_confirmed",
    "stablefx_funded",
    "payout_pending",
    "completed",
    "refunded",
  ] as const)("withholds refund action for %s", async (status) => {
    await renderOperation(status);
    expect(findRefundAction()).toBeNull();
  });

  it("requires deliberate confirmation before posting a refund", async () => {
    await renderOperation("execution_recovery_required");

    const confirmation = await openRefundConfirmation();
    expect(swapScreenMocks.appWallet.refundOperation).not.toHaveBeenCalled();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Request refund" }),
    );

    await waitFor(() =>
      expect(swapScreenMocks.appWallet.refundOperation).toHaveBeenCalledTimes(
        1,
      ),
    );
  });

  it("blocks concurrent confirmed refund clicks", async () => {
    let resolveRefund!: (operation: AppWalletSwapOperationResponse) => void;
    swapScreenMocks.appWallet.refundOperation.mockImplementation(
      () =>
        new Promise<AppWalletSwapOperationResponse>((resolve) => {
          resolveRefund = resolve;
        }),
    );
    await renderOperation("execution_failed");
    const confirmation = await openRefundConfirmation();
    const confirm = within(confirmation).getByRole("button", {
      name: "Request refund",
    });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(swapScreenMocks.appWallet.refundOperation).toHaveBeenCalledTimes(1);

    resolveRefund(createAppWalletOperation("refunded"));
    await waitFor(() =>
      expect(screen.getAllByText("Refund confirmed").length).toBeGreaterThan(0),
    );
  });

  it.each(["refund_pending", "refund_submitted"] as const)(
    "observes %s with GET only on the five-second cadence",
    async (status) => {
      swapScreenMocks.appWallet.refundOperation.mockResolvedValue(
        createAppWalletOperation(status),
      );
      swapScreenMocks.appWallet.getOperation.mockResolvedValue(
        createAppWalletOperation("refunded"),
      );
      await renderOperation("execution_recovery_required");
      const confirmation = await openRefundConfirmation();
      vi.useFakeTimers();
      fireEvent.click(
        within(confirmation).getByRole("button", { name: "Request refund" }),
      );
      await act(async () => Promise.resolve());

      expect(swapScreenMocks.appWallet.refundOperation).toHaveBeenCalledTimes(
        1,
      );
      expect(swapScreenMocks.appWallet.getOperation).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(swapScreenMocks.appWallet.getOperation).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(swapScreenMocks.appWallet.getOperation).toHaveBeenCalledTimes(1);
      expect(swapScreenMocks.appWallet.refundOperation).toHaveBeenCalledTimes(
        1,
      );
      expect(swapScreenMocks.appWallet.executeOperation).not.toHaveBeenCalled();
    },
  );

  it("replaces local state with the backend-returned refund operation", async () => {
    swapScreenMocks.appWallet.refundOperation.mockResolvedValue(
      createAppWalletOperation("refund_submitted", {
        provider: "swapkit",
        refundAmount: "1000000",
        refundTransactionId: "refund-from-backend",
      }),
    );
    await renderOperation("execution_failed", { provider: "swapkit" });
    const confirmation = await openRefundConfirmation();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Request refund" }),
    );

    expect(await screen.findByText("Refund submitted")).toBeVisible();
    expect(screen.getAllByText("SwapKit").length).toBeGreaterThan(0);
  });

  it("keeps operation.provider authoritative and locked during recovery", async () => {
    await renderOperation("execution_recovery_required", {
      provider: "swapkit",
    });

    const provider = screen.getAllByRole("combobox")[2];
    expect(provider).toBeDisabled();
    expect(provider).toHaveTextContent("SwapKit");
  });

  it("treats refunded as terminal", async () => {
    await renderOperation("refunded", {
      provider: "swapkit",
      refundAmount: "1000000",
      refundConfirmedAt: "2026-07-26T00:02:00.000Z",
    });

    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    expect(findRefundAction()).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry status check" }),
    ).toBeNull();
    expect(screen.getAllByRole("combobox")[2]).toBeDisabled();
  });

  it("surfaces backend refund rejection through existing error and toast behavior", async () => {
    swapScreenMocks.appWallet.refundOperation.mockRejectedValue(
      new Error("Refund remains blocked by settlement safety checks."),
    );
    await renderOperation("execution_recovery_required");
    const confirmation = await openRefundConfirmation();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Request refund" }),
    );

    await waitFor(() =>
      expect(swapScreenMocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Refund remains blocked by settlement safety checks.",
          title: "Refund request failed",
          variant: "destructive",
        }),
      ),
    );
    expect(
      await screen.findByText(
        "Refund remains blocked by settlement safety checks.",
      ),
    ).toBeVisible();
  });
});
