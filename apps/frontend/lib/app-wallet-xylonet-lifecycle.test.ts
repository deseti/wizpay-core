import { describe, expect, it, vi } from "vitest";

import { runAppWalletXylonetLifecycle } from "@/lib/app-wallet-xylonet-lifecycle";
import type { AppWalletXylonetOperationResponse } from "@/lib/app-wallet-swap-service";

function operation(
  lifecycleStage: AppWalletXylonetOperationResponse["lifecycleStage"],
  overrides: Partial<AppWalletXylonetOperationResponse> = {},
): AppWalletXylonetOperationResponse {
  return {
    operationId: "operation-1",
    executionMode: "direct-user-controlled",
    provider: "xylonet",
    applicationUserId: "user-1",
    circleWalletId: "wallet-1",
    walletAddress: "0x1111111111111111111111111111111111111111",
    chain: "ARC-TESTNET",
    chainId: 5042002,
    tokenIn: "USDC",
    tokenOut: "EURC",
    tokenInAddress: "0x2222222222222222222222222222222222222222",
    tokenOutAddress: "0x3333333333333333333333333333333333333333",
    amountIn: "9999999",
    expectedOutput: "9900000",
    minimumOutput: "9800000",
    slippageBps: 200,
    feeBps: 0,
    routerAddress: "0x4444444444444444444444444444444444444444",
    executorAddress: "0x5555555555555555555555555555555555555555",
    recipientAddress: "0x1111111111111111111111111111111111111111",
    deadline: "2026-08-22T01:00:00.000Z",
    lifecycleStage,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("shared XyloNet User-Controlled lifecycle", () => {
  it.each([
    ["USDC", "EURC"],
    ["EURC", "USDC"],
  ] as const)(
    "completes buffered 1-token Payroll lifecycle for %s to %s",
    async (tokenIn, tokenOut) => {
      const final = operation("completed", {
        tokenIn,
        tokenOut,
        amountIn: "1020000",
        terminalStatus: "confirmed",
        swapTransactionHash: `0x${"b".repeat(64)}`,
        verifiedActualOutput: "987654",
      });
      const api = {
        createApprovalChallenge: vi.fn(),
        createSwapChallenge: vi.fn(),
        recordChallengeResult: vi.fn(),
        poll: vi.fn().mockResolvedValue(final),
      };

      await expect(
        runAppWalletXylonetLifecycle({
          initialOperation: operation("swap_submitted", {
            tokenIn,
            tokenOut,
            amountIn: "1020000",
          }),
          userToken: "token",
          executeChallenge: vi.fn(),
          pollIntervalMs: 0,
          api,
        }),
      ).resolves.toMatchObject({
        provider: "xylonet",
        tokenIn,
        tokenOut,
        amountIn: "1020000",
        verifiedActualOutput: "987654",
      });
    },
  );

  it("executes approval then swap and returns confirmed wallet output", async () => {
    const api = {
      createApprovalChallenge: vi
        .fn()
        .mockResolvedValue(
          operation("awaiting_approval_confirmation", {
            approvalChallengeId: "approval",
          }),
        ),
      recordChallengeResult: vi
        .fn()
        .mockResolvedValueOnce(operation("approval_submitted"))
        .mockResolvedValueOnce(operation("swap_submitted")),
      poll: vi
        .fn()
        .mockResolvedValueOnce(operation("approval_confirmed"))
        .mockResolvedValueOnce(
          operation("completed", {
            terminalStatus: "confirmed",
            swapTransactionHash: `0x${"a".repeat(64)}`,
            verifiedActualOutput: "9800000",
          }),
        ),
      createSwapChallenge: vi
        .fn()
        .mockResolvedValue(
          operation("awaiting_swap_confirmation", { swapChallengeId: "swap" }),
        ),
    };
    const executeChallenge = vi.fn().mockResolvedValue({ status: "COMPLETE" });

    const result = await runAppWalletXylonetLifecycle({
      initialOperation: operation("created"),
      userToken: "token",
      executeChallenge,
      pollIntervalMs: 0,
      api,
    });

    expect(result.terminalStatus).toBe("confirmed");
    expect(executeChallenge).toHaveBeenNthCalledWith(1, "approval");
    expect(executeChallenge).toHaveBeenNthCalledWith(2, "swap");
    expect(api.createSwapChallenge).toHaveBeenCalledOnce();
  });

  it("does not create a swap challenge when approval is rejected", async () => {
    const api = {
      createApprovalChallenge: vi
        .fn()
        .mockResolvedValue(
          operation("awaiting_approval_confirmation", {
            approvalChallengeId: "approval",
          }),
        ),
      createSwapChallenge: vi.fn(),
      poll: vi.fn(),
      recordChallengeResult: vi
        .fn()
        .mockResolvedValue(
          operation("rejected", { terminalStatus: "rejected" }),
        ),
    };
    await expect(
      runAppWalletXylonetLifecycle({
        initialOperation: operation("created"),
        userToken: "token",
        executeChallenge: vi.fn().mockRejectedValue(new Error("rejected")),
        pollIntervalMs: 0,
        api,
      }),
    ).rejects.toThrow("rejected");
    expect(api.createSwapChallenge).not.toHaveBeenCalled();
    expect(api.poll).not.toHaveBeenCalled();
  });
});
