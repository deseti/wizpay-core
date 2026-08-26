import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInvoice,
  getPublicInvoice,
  listInvoices,
  verifyPublicInvoicePayment,
} from "@/lib/invoice-api";

describe("invoice API boundary", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          text: async () => JSON.stringify({ data: {} }),
        }),
    );
  });

  it("uses Circle bearer authorization only for merchant endpoints and never sends merchant identity", async () => {
    await createInvoice(
      { token: "USDC", amount: "0.1", title: "Invoice" },
      "circle-token",
    );
    const [, request] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      "Bearer circle-token",
    );
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({ token: "USDC", amount: "0.1", title: "Invoice" });
    expect(body).not.toHaveProperty("merchantUserId");
    expect(body).not.toHaveProperty("merchantWalletAddress");
    await listInvoices("circle-token", {
      status: "OPEN",
      limit: 10,
      offset: 0,
    });
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain(
      "status=OPEN&limit=10&offset=0",
    );
  });

  it("keeps public checkout unauthenticated and submits only the transaction hash for verification", async () => {
    await getPublicInvoice("abcdefghijklmnopqrstuv");
    expect(
      new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has(
        "Authorization",
      ),
    ).toBe(false);
    const hash = `0x${"a".repeat(64)}`;
    await verifyPublicInvoicePayment("abcdefghijklmnopqrstuv", hash);
    const [, request] = vi.mocked(fetch).mock.calls[1];
    expect(new Headers(request?.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(request?.body))).toEqual({
      transactionHash: hash,
    });
  });
});
