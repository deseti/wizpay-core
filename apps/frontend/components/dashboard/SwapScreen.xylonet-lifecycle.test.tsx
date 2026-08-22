import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createXylonetOperation,
  renderSwapScreen,
  resetSwapScreenMocks,
  swapScreenMocks,
} from "@/test/support/swap-screen";

async function openDirectOperation() {
  renderSwapScreen();
  fireEvent.change(screen.getByPlaceholderText("0.0"), {
    target: { value: "1" },
  });
  await waitFor(() =>
    expect(swapScreenMocks.appWallet.xylonetQuote).toHaveBeenCalled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Confirm swap" }));
  return screen.findByRole("dialog");
}

describe("SwapScreen direct User-Controlled XyloNet lifecycle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSwapScreenMocks();
  });

  it("opens approval then swap confirmations and renders verified completion", async () => {
    swapScreenMocks.appWallet.xylonetPoll
      .mockResolvedValueOnce(createXylonetOperation("approval_submitted"))
      .mockResolvedValueOnce(createXylonetOperation("approval_confirmed"))
      .mockResolvedValueOnce(
        createXylonetOperation("completed", {
          terminalStatus: "confirmed",
          completedAt: "2026-08-21T00:00:00.000Z",
        }),
      );
    const dialog = await openDirectOperation();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Start User-Controlled swap",
      }),
    );

    await waitFor(
      () =>
        expect(
          swapScreenMocks.appWallet.xylonetSwapChallenge,
        ).toHaveBeenCalled(),
      { timeout: 4_000 },
    );
    expect(swapScreenMocks.circle.executeChallenge).toHaveBeenNthCalledWith(
      1,
      "approval-challenge-1",
    );
    expect(swapScreenMocks.appWallet.xylonetPoll).toHaveBeenCalled();
    expect(screen.queryByText("User-Controlled swap stopped")).toBeNull();
    await waitFor(
      () =>
        expect(swapScreenMocks.circle.executeChallenge).toHaveBeenNthCalledWith(
          2,
          "swap-challenge-1",
        ),
      { timeout: 4_000 },
    );
    expect(
      await screen.findByText("User-Controlled swap completed"),
    ).toBeVisible();
    expect(screen.getByText("Output verified")).toBeVisible();
  });

  it("maps callback cancellation to a terminal cancelled state", async () => {
    swapScreenMocks.circle.executeChallenge.mockRejectedValueOnce(
      new Error("User cancelled confirmation"),
    );
    swapScreenMocks.appWallet.xylonetApprovalResult.mockResolvedValueOnce(
      createXylonetOperation("cancelled", {
        terminalStatus: "cancelled",
        failureReason: "User cancelled confirmation",
      }),
    );
    const dialog = await openDirectOperation();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Start User-Controlled swap",
      }),
    );

    expect(
      await screen.findByText("User-Controlled swap stopped"),
    ).toBeVisible();
    expect(
      screen.getAllByText("User cancelled confirmation").length,
    ).toBeGreaterThan(0);
    expect(
      swapScreenMocks.appWallet.xylonetSwapChallenge,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected", "REJECTED"],
    ["expired", "EXPIRED"],
    ["failed", "FAILED"],
  ])("does not leave a %s callback in a spinner", async (stage, status) => {
    swapScreenMocks.circle.executeChallenge.mockResolvedValueOnce({ status });
    swapScreenMocks.appWallet.xylonetApprovalResult.mockResolvedValueOnce(
      createXylonetOperation(stage as "rejected" | "expired" | "failed", {
        terminalStatus: stage as "rejected" | "expired" | "failed",
        failureReason: `Challenge ${stage}`,
      }),
    );
    const dialog = await openDirectOperation();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Start User-Controlled swap",
      }),
    );
    expect(
      await screen.findByText("User-Controlled swap stopped"),
    ).toBeVisible();
    expect(screen.queryByText("Waiting for confirmation...")).toBeNull();
  });

  it("prevents duplicate clicks from creating duplicate challenges", async () => {
    let resolveChallenge!: (value: unknown) => void;
    swapScreenMocks.circle.executeChallenge.mockImplementationOnce(
      () => new Promise((resolve) => (resolveChallenge = resolve)),
    );
    const dialog = await openDirectOperation();
    const button = within(dialog).getByRole("button", {
      name: "Start User-Controlled swap",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        swapScreenMocks.appWallet.xylonetApprovalChallenge,
      ).toHaveBeenCalledTimes(1),
    );
    await act(async () => resolveChallenge({ status: "CANCELLED" }));
  });

  it("resumes a submitted operation after refresh and stops on completion", async () => {
    window.localStorage.setItem(
      "wizpay:xylonet-app-wallet-operation:circle-wallet-1",
      "22222222-2222-4222-8222-222222222222",
    );
    swapScreenMocks.appWallet.xylonetGetOperation.mockResolvedValueOnce(
      createXylonetOperation("swap_submitted", {
        swapChallengeId: "swap-challenge-1",
      }),
    );
    swapScreenMocks.appWallet.xylonetPoll.mockResolvedValueOnce(
      createXylonetOperation("completed", {
        terminalStatus: "confirmed",
        verifiedActualOutput: "980000",
      }),
    );
    renderSwapScreen();

    expect(
      await screen.findByText("User-Controlled swap completed"),
    ).toBeVisible();
    expect(swapScreenMocks.appWallet.xylonetPoll).toHaveBeenCalledTimes(1);
  });

  it("renders the completed swap hash and clickable ArcScan transaction link", async () => {
    const txHash = `0x${"a".repeat(64)}`;
    window.localStorage.setItem(
      "wizpay:xylonet-app-wallet-operation:circle-wallet-1",
      "22222222-2222-4222-8222-222222222222",
    );
    swapScreenMocks.appWallet.xylonetGetOperation.mockResolvedValueOnce(
      createXylonetOperation("completed", {
        terminalStatus: "confirmed",
        swapTransactionId: "circle-swap-transaction-id",
        swapTransactionHash: txHash,
      }),
    );

    renderSwapScreen();

    expect(await screen.findByText("Swap transaction hash")).toBeVisible();
    expect(screen.getByText(txHash)).toBeVisible();
    const link = screen.getByRole("link", {
      name: "View transaction on ArcScan",
    });
    expect(link).toHaveAttribute(
      "href",
      `https://testnet.arcscan.app/tx/${txHash}`,
    );
  });

  it("renders a pending hash state without an invalid ArcScan link", async () => {
    window.localStorage.setItem(
      "wizpay:xylonet-app-wallet-operation:circle-wallet-1",
      "22222222-2222-4222-8222-222222222222",
    );
    swapScreenMocks.appWallet.xylonetGetOperation.mockResolvedValueOnce(
      createXylonetOperation("completed", {
        terminalStatus: "confirmed",
        swapTransactionId: "circle-swap-transaction-id",
      }),
    );

    renderSwapScreen();

    expect(await screen.findByText("Pending from Circle")).toBeVisible();
    expect(
      screen.getByText(/ArcScan link pending until Circle returns/),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "View transaction on ArcScan" }),
    ).toBeNull();
  });
});
