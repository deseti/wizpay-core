import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AppWalletSwapOperationResponse,
  type AppWalletSwapQuoteResponse,
  executeAppWalletSwapOperation,
  quoteAppWalletSwap,
  refundAppWalletSwapOperation,
} from "@/lib/app-wallet-swap-service";

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function quoteFixture(): AppWalletSwapQuoteResponse {
  return {
    amountIn: "1000000",
    expectedOutput: "990000",
    expiresAt: "2026-07-26T00:05:00.000Z",
    minimumOutput: "970000",
    operationMode: "treasury-mediated",
    provider: "swapkit",
    sourceChain: "ARC-TESTNET",
    status: "quoted",
    tokenIn: "USDC",
    tokenOut: "EURC",
    treasuryDepositAddress: "0x2222222222222222222222222222222222222222",
  };
}

function operationFixture(): AppWalletSwapOperationResponse {
  return {
    ...quoteFixture(),
    createdAt: "2026-07-26T00:00:00.000Z",
    executionEnabled: true,
    operationId: "operation-1",
    status: "refund_submitted",
    updatedAt: "2026-07-26T00:01:00.000Z",
    userWalletAddress: "0x1111111111111111111111111111111111111111",
  };
}

describe("App Wallet swap API contract", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = "http://frontend-test.invalid";
  });

  it("preserves the quote path, body, and { data } response envelope", async () => {
    const quote = quoteFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(quote));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      quoteAppWalletSwap({
        amountIn: "1000000",
        chain: "ARC-TESTNET",
        fromAddress: "0x1111111111111111111111111111111111111111",
        provider: "swapkit",
        tokenIn: "USDC",
        tokenOut: "EURC",
      }),
    ).resolves.toEqual(quote);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://frontend-test.invalid/app-wallet-swap/quote",
      expect.objectContaining({
        body: JSON.stringify({
          amountIn: "1000000",
          chain: "ARC-TESTNET",
          fromAddress: "0x1111111111111111111111111111111111111111",
          provider: "swapkit",
          tokenIn: "USDC",
          tokenOut: "EURC",
        }),
        cache: "no-store",
        method: "POST",
      }),
    );
  });

  it("preserves the refund POST path and { data } response envelope", async () => {
    const operation = operationFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(operation));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refundAppWalletSwapOperation("operation/with spaces"),
    ).resolves.toEqual(operation);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://frontend-test.invalid/app-wallet-swap/operations/operation%2Fwith%20spaces/refund",
      expect.objectContaining({
        cache: "no-store",
        method: "POST",
      }),
    );
  });

  it("aborts an execute request after 25 seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = executeAppWalletSwapOperation("operation-1");
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_999);
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await rejection;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
