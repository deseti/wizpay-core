import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backendFetch } from "@/lib/backend-api";
import { useBatchPayroll } from "@/hooks/wizpay/useBatchPayroll";
import type { TokenSymbol } from "@/lib/wizpay";

vi.mock("@/hooks/useActiveWalletAddress", () => ({
  useActiveWalletAddress: () => ({
    walletAddress: "0x1111111111111111111111111111111111111111",
    walletMode: "circle",
  }),
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
  beforeEach(() => backendFetchMock.mockReset());

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

  it("keeps same-token Payroll outside XyloNet", async () => {
    const { executePreSwap, options } = setup("USDC", "USDC");
    const { result } = renderHook(() => useBatchPayroll({
      ...options, officialQuoteRequired: false, officialQuoteReady: false,
    }));
    await act(async () => result.current.execute());
    expect(executePreSwap).not.toHaveBeenCalled();
    expect(backendFetchMock).toHaveBeenCalledWith("/tasks/payroll/init", expect.anything());
  });
});
