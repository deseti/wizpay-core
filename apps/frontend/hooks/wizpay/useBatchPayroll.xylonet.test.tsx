import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backendFetch } from "@/lib/backend-api";
import { useBatchPayroll } from "@/hooks/wizpay/useBatchPayroll";
import type { TokenSymbol } from "@/lib/wizpay";
import type { WalletMode } from "@/lib/wallet-mode";

let activeWalletMode: WalletMode = "circle";

vi.mock("@/hooks/useActiveWalletAddress", () => ({
  useActiveWalletAddress: () => ({
    walletAddress: "0x1111111111111111111111111111111111111111",
    walletMode: activeWalletMode,
  }),
}));
vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => ({ userToken: "circle-user-token" }),
}));
vi.mock("@/lib/backend-api", () => ({ backendFetch: vi.fn() }));

const backendFetchMock = vi.mocked(backendFetch);
const task = {
  id: "task-1", status: "executed", logs: [], units: [],
  totalUnits: 0, completedUnits: 0, failedUnits: 0,
};

function setup(sourceToken: TokenSymbol, targetToken: TokenSymbol) {
  const executePreSwap = vi.fn().mockResolvedValue({
    settledToken: targetToken,
    txHash: `0x${"a".repeat(64)}`,
    provider: "xylonet",
    outputToken: targetToken,
    verifiedActualOutput: "987654",
  });
  backendFetchMock.mockImplementation(async (path) => {
    if (path === "/tasks/payroll/init") {
      return {
        taskId: "task-1", approvalAmount: "0", referenceId: "payroll-1",
        totalUnits: 0, units: [],
      } as never;
    }
    return task as never;
  });
  const options = {
    activeToken: { symbol: sourceToken, decimals: 6 },
    approveBatchAmount: vi.fn(), currentAllowance: 0n,
    recipients: [{
      id: "recipient-1",
      address: "0x2222222222222222222222222222222222222222",
      amount: "1",
      targetToken,
    }],
    pendingBatches: [], referenceId: "payroll-1",
    refetchAllowance: vi.fn(), setErrorMessage: vi.fn(),
    setStatusMessage: vi.fn(), submitCurrentBatch: vi.fn(),
    executePreSwap,
    getPreSwapPayoutAmounts: () => new Map([["recipient-1", "897907"]]),
    officialQuoteRequired: true, officialQuoteReady: true,
  };
  return { executePreSwap, options };
}

describe("useBatchPayroll XyloNet confirmed output", () => {
  beforeEach(() => {
    activeWalletMode = "circle";
    backendFetchMock.mockReset();
  });

  it.each([
    ["USDC", "EURC"],
    ["EURC", "USDC"],
  ] as const)("uses verified output for 1 %s to %s", async (sourceToken, targetToken) => {
    const { executePreSwap, options } = setup(sourceToken, targetToken);
    const { result } = renderHook(() => useBatchPayroll(options));
    await act(async () => result.current.execute());

    expect(executePreSwap).toHaveBeenCalledWith({
      sourceToken, targetToken, amount: "1020000", routingAmount: "1000000",
      minimumRequiredOutput: "897907",
    });
    const initCall = backendFetchMock.mock.calls.find(([path]) => path === "/tasks/payroll/init");
    const body = JSON.parse(String(initCall?.[1]?.body));
    expect(body.recipients).toEqual([{
      address: "0x2222222222222222222222222222222222222222",
      amount: "0.987654",
      targetToken,
    }]);
  });

  it("does not submit Payroll when the XyloNet swap fails", async () => {
    const { executePreSwap, options } = setup("USDC", "EURC");
    executePreSwap.mockRejectedValueOnce(new Error("swap failed"));
    const { result } = renderHook(() => useBatchPayroll(options));
    await act(async () => result.current.execute());
    expect(backendFetchMock).not.toHaveBeenCalled();
  });

  it("prevents duplicate Send from executing a second XyloNet swap", async () => {
    const { executePreSwap, options } = setup("USDC", "EURC");
    let release!: (value: unknown) => void;
    executePreSwap.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useBatchPayroll(options));
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.execute();
      await result.current.execute();
    });
    expect(executePreSwap).toHaveBeenCalledTimes(1);
    release({
      settledToken: "EURC", txHash: `0x${"a".repeat(64)}`,
      provider: "xylonet", outputToken: "EURC", verifiedActualOutput: "987654",
    });
    await act(async () => first);
  });

  it("keeps App Wallet same-token Payroll on its direct path", async () => {
    const { executePreSwap, options } = setup("USDC", "USDC");
    const { result } = renderHook(() => useBatchPayroll({
      ...options, officialQuoteRequired: false, officialQuoteReady: false,
    }));
    await act(async () => result.current.execute());
    expect(executePreSwap).not.toHaveBeenCalled();
    expect(backendFetchMock).toHaveBeenCalledWith("/tasks/payroll/init", expect.anything());
  });

  it.each([
    ["USDC", "USDC"],
    ["EURC", "EURC"],
  ] as const)(
    "submits External Wallet %s to %s directly without a swap quote",
    async (sourceToken, targetToken) => {
      activeWalletMode = "external";
      const { executePreSwap, options } = setup(sourceToken, targetToken);
      const { result } = renderHook(() =>
        useBatchPayroll({
          ...options,
          officialQuoteRequired: false,
          officialQuoteReady: false,
        }),
      );

      await act(async () => result.current.execute());

      expect(executePreSwap).not.toHaveBeenCalled();
      expect(backendFetchMock).toHaveBeenCalledWith(
        "/tasks/payroll/init",
        expect.anything(),
      );
      expect(
        backendFetchMock.mock.calls.some(([path]) =>
          String(path).includes("/user-swap/quote"),
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["USDC", "EURC"],
    ["EURC", "USDC"],
  ] as const)(
    "submits External Wallet %s to %s as a target-token payroll plan",
    async (sourceToken, targetToken) => {
      activeWalletMode = "external";
      const { executePreSwap, options } = setup(sourceToken, targetToken);
      const { result } = renderHook(() =>
        useBatchPayroll({
          ...options,
          getRecoveredPayrollBatch: vi.fn().mockResolvedValue(null),
          recordPayrollBatchConfirmation: vi.fn(),
          beginPayrollBatchSubmission: vi.fn(),
          clearPayrollBatchSubmission: vi.fn(),
        }),
      );

      await act(async () => result.current.execute());

      expect(executePreSwap).toHaveBeenCalledTimes(1);
      const initCall = backendFetchMock.mock.calls.find(
        ([path]) => path === "/tasks/payroll/init",
      );
      const body = JSON.parse(String(initCall?.[1]?.body));
      expect(body.sourceToken).toBe(targetToken);
      expect(body.recipients).toEqual([
        expect.objectContaining({ targetToken, amount: "0.987654" }),
      ]);
    },
  );

  it("splits a mixed External Wallet batch into homogeneous source-token plans", async () => {
    activeWalletMode = "external";
    const { executePreSwap, options } = setup("USDC", "EURC");
    const { result } = renderHook(() =>
      useBatchPayroll({
        ...options,
        recipients: [
          {
            ...options.recipients[0],
            targetToken: "USDC",
          },
          {
            id: "recipient-2",
            address: "0x3333333333333333333333333333333333333333",
            amount: "1",
            targetToken: "EURC",
          },
        ],
        getPreSwapPayoutAmounts: () => new Map([["recipient-2", "987654"]]),
        getRecoveredPayrollBatch: vi.fn().mockResolvedValue(null),
        recordPayrollBatchConfirmation: vi.fn(),
        beginPayrollBatchSubmission: vi.fn(),
        clearPayrollBatchSubmission: vi.fn(),
      }),
    );

    await act(async () => result.current.execute());

    expect(executePreSwap).toHaveBeenCalledWith(
      expect.objectContaining({ routingAmount: "1000000" }),
    );
    const initBodies = backendFetchMock.mock.calls
      .filter(([path]) => path === "/tasks/payroll/init")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(initBodies).toHaveLength(2);
    expect(initBodies.map((body) => body.sourceToken)).toEqual([
      "USDC",
      "EURC",
    ]);
    expect(initBodies[0].recipients).toEqual([
      expect.objectContaining({ targetToken: "USDC", amount: "1" }),
    ]);
    expect(initBodies[1].recipients).toEqual([
      expect.objectContaining({ targetToken: "EURC", amount: "0.987654" }),
    ]);
  });

  it("allocates verified output proportionally across External recipients", async () => {
    activeWalletMode = "external";
    const { options } = setup("USDC", "EURC");
    options.executePreSwap.mockResolvedValueOnce({
      settledToken: "EURC",
      txHash: `0x${"a".repeat(64)}`,
      provider: "xylonet",
      outputToken: "EURC",
      verifiedActualOutput: "1000001",
    });
    const { result } = renderHook(() =>
      useBatchPayroll({
        ...options,
        recipients: [
          options.recipients[0],
          {
            id: "recipient-2",
            address: "0x3333333333333333333333333333333333333333",
            amount: "2",
            targetToken: "EURC",
          },
        ],
        getPreSwapPayoutAmounts: () =>
          new Map([
            ["recipient-1", "300000"],
            ["recipient-2", "600000"],
          ]),
        getRecoveredPayrollBatch: vi.fn().mockResolvedValue(null),
        recordPayrollBatchConfirmation: vi.fn(),
        beginPayrollBatchSubmission: vi.fn(),
        clearPayrollBatchSubmission: vi.fn(),
      }),
    );

    await act(async () => result.current.execute());

    const initCall = backendFetchMock.mock.calls.find(
      ([path]) => path === "/tasks/payroll/init",
    );
    const body = JSON.parse(String(initCall?.[1]?.body));
    expect(body.recipients.map((recipient: { amount: string }) => recipient.amount)).toEqual([
      "0.333333",
      "0.666668",
    ]);
  });

  it("retries payroll distribution after a confirmed swap without blocking recovery", async () => {
    activeWalletMode = "external";
    const { executePreSwap, options } = setup("USDC", "EURC");
    const submitCurrentBatch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, hash: null, error: "payroll failed" })
      .mockResolvedValueOnce({ ok: true, hash: `0x${"c".repeat(64)}` });
    const recordPayrollBatchConfirmation = vi.fn();
    const unit = {
      id: "unit-1",
      index: 0,
      type: "batch",
      status: "PENDING",
      payload: {
        referenceId: "payroll-1",
        recipients: [{
          address: "0x2222222222222222222222222222222222222222",
          amount: "0.987654",
          targetToken: "EURC",
        }],
      },
    };
    backendFetchMock.mockImplementation(async (path) => {
      if (path === "/tasks/payroll/init") {
        return {
          taskId: "task-1", approvalAmount: "0", referenceId: "payroll-1",
          totalUnits: 1, units: [unit],
        } as never;
      }
      if (String(path).includes("/report")) {
        return { task, unit, nextUnit: null } as never;
      }
      return task as never;
    });
    const { result } = renderHook(() =>
      useBatchPayroll({
        ...options,
        submitCurrentBatch,
        getRecoveredPayrollBatch: vi.fn().mockResolvedValue(null),
        recordPayrollBatchConfirmation,
        beginPayrollBatchSubmission: vi.fn(),
        clearPayrollBatchSubmission: vi.fn(),
      }),
    );

    await act(async () => result.current.execute());
    await act(async () => result.current.execute());

    expect(executePreSwap).toHaveBeenCalledTimes(2);
    expect(submitCurrentBatch).toHaveBeenCalledTimes(2);
    expect(recordPayrollBatchConfirmation).toHaveBeenCalledWith(
      "payroll-1",
      `0x${"c".repeat(64)}`,
    );
  });

  it("does not resubmit a receipt-verified recovered payroll batch", async () => {
    activeWalletMode = "external";
    const { options } = setup("USDC", "EURC");
    const recoveredHash = `0x${"d".repeat(64)}`;
    const unit = {
      id: "unit-1",
      index: 0,
      type: "batch",
      status: "PENDING",
      payload: {
        referenceId: "payroll-1",
        recipients: [{
          address: "0x2222222222222222222222222222222222222222",
          amount: "0.987654",
          targetToken: "EURC",
        }],
      },
    };
    backendFetchMock.mockImplementation(async (path) => {
      if (path === "/tasks/payroll/init") {
        return {
          taskId: "task-1", approvalAmount: "0", referenceId: "payroll-1",
          totalUnits: 1, units: [unit],
        } as never;
      }
      if (String(path).includes("/report")) {
        return { task, unit, nextUnit: null } as never;
      }
      return task as never;
    });
    const { result } = renderHook(() =>
      useBatchPayroll({
        ...options,
        getRecoveredPayrollBatch: vi.fn().mockResolvedValue(recoveredHash),
        recordPayrollBatchConfirmation: vi.fn(),
        beginPayrollBatchSubmission: vi.fn(),
        clearPayrollBatchSubmission: vi.fn(),
      }),
    );

    await act(async () => result.current.execute());

    expect(options.submitCurrentBatch).not.toHaveBeenCalled();
    const reportCall = backendFetchMock.mock.calls.find(([path]) =>
      String(path).includes("/report"),
    );
    expect(JSON.parse(String(reportCall?.[1]?.body))).toEqual({
      status: "SUCCESS",
      txHash: recoveredHash,
    });
  });
});
