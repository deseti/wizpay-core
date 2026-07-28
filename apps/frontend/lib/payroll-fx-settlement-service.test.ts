import { beforeEach, describe, expect, it, vi } from "vitest";
import { settlePayrollFx } from "@/lib/payroll-fx-settlement-service";

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("Payroll FX frontend API contract (characterization)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = "http://frontend-test.invalid";
  });

  it("preserves the current App Wallet settlement path and provider-free payload", async () => {
    const data = {
      sourceToken: "USDC",
      targetToken: "EURC",
      sourceAmount: "30600000",
      targetAmount: "29750001",
      txHash: `0x${"b".repeat(64)}`,
      payoutTxHash: `0x${"c".repeat(64)}`,
      status: "settled",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(data));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      settlePayrollFx({
        sourceToken: "USDC",
        targetToken: "EURC",
        sourceAmount: "30600000",
        referenceId: "frontend-payroll-fx",
        walletAddress: "0x1111111111111111111111111111111111111111",
        sourceFundingTxHash: `0x${"a".repeat(64)}`,
      }),
    ).resolves.toEqual(data);

    const expectedBody = {
      sourceToken: "USDC",
      targetToken: "EURC",
      sourceAmount: "30600000",
      referenceId: "frontend-payroll-fx",
      walletAddress: "0x1111111111111111111111111111111111111111",
      sourceFundingTxHash: `0x${"a".repeat(64)}`,
    };
    expect(fetchMock).toHaveBeenCalledWith(
      "http://frontend-test.invalid/tasks/payroll/fx-settle",
      expect.objectContaining({
        body: JSON.stringify(expectedBody),
        cache: "no-store",
        method: "POST",
      }),
    );
    expect(expectedBody).not.toHaveProperty("provider");
  });

  it.todo(
    "reconstructs an App Wallet payroll FX attempt after component remount from durable state (Phase 1-3)",
  );
  it.todo(
    "proves direct-token hook execution never calls the FX settlement endpoint once a hook seam exists",
  );
  it.todo(
    "freezes External Wallet payroll request construction once its orchestration is extracted behind a test seam",
  );
});
