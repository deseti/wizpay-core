import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppWalletXylonetOperation,
  quoteAppWalletXylonetSwap,
} from "./app-wallet-swap-service";

const request = {
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  walletId: "22222222-2222-4222-8222-222222222222",
  walletAddress: "0x90ab859240b941eaf0cbcbf42df5086e0ad54147",
  chain: "ARC-TESTNET" as const,
  tokenIn: "USDC" as const,
  tokenOut: "EURC" as const,
  amountIn: "1000000",
  slippageBps: 200,
};

describe("App Wallet XyloNet API client", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = "http://frontend-test.invalid";
  });

  it.each([
    [quoteAppWalletXylonetSwap, "/app-wallet-swap/xylonet/quote"],
    [createAppWalletXylonetOperation, "/app-wallet-swap/xylonet/operations"],
  ] as const)("sends a user-token-scoped request to %s", async (call, path) => {
    const response = {
      operationId: request.idempotencyKey,
      provider: "xylonet",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: response }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(call(request, "circle-user-token")).resolves.toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://frontend-test.invalid${path}`);
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(new Headers(init.headers).get("X-User-Token")).toBe(
      "circle-user-token",
    );
  });
});
