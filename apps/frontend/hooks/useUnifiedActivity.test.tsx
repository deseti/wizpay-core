import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUnifiedActivity } from "@/hooks/useUnifiedActivity";
import { backendFetch } from "@/lib/backend-api";

vi.mock("@/lib/backend-api", () => ({ backendFetch: vi.fn() }));

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function activity(id: string, type: "send" | "receive" = "send") {
  return {
    id,
    type,
    direction: type === "send" ? "outgoing" : "incoming",
    status: "completed",
    source: "circle_w3s",
    sourceReferenceType: "circle_transaction",
    sourceReferenceId: id,
    taskId: null,
    operationId: null,
    challengeId: null,
    transactionId: id,
    chainId: 5042002,
    txHash: `0x${"a".repeat(64)}`,
    inputTokenSymbol: "USDC",
    inputTokenAddress: null,
    inputAmount: "1000000",
    outputTokenSymbol: null,
    outputTokenAddress: null,
    outputAmount: null,
    feeAmount: null,
    feeTokenSymbol: null,
    counterparty: null,
    metadata: null,
    occurredAt: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  } as const;
}

describe("useUnifiedActivity session isolation", () => {
  beforeEach(() => {
    client.clear();
    vi.mocked(backendFetch).mockReset();
  });

  it("never renders User A cached rows while switching to User B", async () => {
    let resolveB!: (value: {
      items: ReturnType<typeof activity>[];
      nextCursor: null;
    }) => void;
    vi.mocked(backendFetch).mockImplementation((path, options) => {
      if (path === "/activities/sync") {
        const authorization = String(
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization ?? "",
        );
        return Promise.resolve({
          status: "throttled",
          readSessionToken: authorization.includes("user-a-token")
            ? "session-a"
            : "session-b",
        });
      }
      const authorization = String(
        (options?.headers as Record<string, string> | undefined)
          ?.Authorization ?? "",
      );
      if (authorization.includes("session-a"))
        return Promise.resolve({ items: [activity("a")], nextCursor: null });
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });
    const { result, rerender } = renderHook(
      ({ token }) => useUnifiedActivity({ userToken: token }),
      { wrapper, initialProps: { token: "user-a-token" } },
    );
    await waitFor(() =>
      expect(result.current.items.map((row) => row.id)).toEqual(["a"]),
    );
    rerender({ token: "user-b-token" });
    expect(result.current.items).toEqual([]);
    await waitFor(() => expect(resolveB).toBeTypeOf("function"));
    await act(async () => {
      resolveB({ items: [], nextCursor: null });
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toEqual([]);
  });

  it("starts one asynchronous sync for an authenticated session", async () => {
    vi.mocked(backendFetch).mockImplementation((path) =>
      Promise.resolve(
        path === "/activities/sync"
          ? { status: "throttled", readSessionToken: "one-session" }
          : { items: [], nextCursor: null },
      ),
    );
    const { rerender } = renderHook(
      ({ token }) => useUnifiedActivity({ userToken: token }),
      { wrapper, initialProps: { token: "one-session-token" } },
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(backendFetch)
          .mock.calls.filter(([path]) => path === "/activities/sync"),
      ).toHaveLength(1),
    );
    rerender({ token: "one-session-token" });
    expect(
      vi
        .mocked(backendFetch)
        .mock.calls.filter(([path]) => path === "/activities/sync"),
    ).toHaveLength(1);
  });

  it("does not call the private API without authentication", () => {
    const { result } = renderHook(
      () => useUnifiedActivity({ userToken: null }),
      { wrapper },
    );
    expect(result.current.items).toEqual([]);
    expect(backendFetch).not.toHaveBeenCalled();
  });
});
