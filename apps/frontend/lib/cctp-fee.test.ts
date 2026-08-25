import { beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_TESTNETS, type BridgeTestnetCode } from "@wizpay/bridge-registry";

import {
  CctpFeeError,
  calculateCctpMaxFee,
  clearCctpFeeCache,
  createCctpFeeRequestCoordinator,
  resolveStandardCctpFee,
} from "./cctp-fee";

const HUB = "ARC-TESTNET" as const;
const SPOKES = BRIDGE_TESTNETS.filter((network) => network.code !== HUB);

function feeResponse(
  standardFee = 0,
  entries: unknown[] = [
    { finalityThreshold: 1000, minimumFee: 1.3 },
    { finalityThreshold: 2000, minimumFee: standardFee },
  ],
) {
  return new Response(JSON.stringify(entries), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CCTP V2 Standard Transfer fee resolution", () => {
  beforeEach(() => clearCctpFeeCache());

  it.each(SPOKES.map((network) => [network.code, network.cctpDomain] as const))(
    "%s -> Arc resolves from the official source/destination fee route",
    async (sourceCode, sourceDomain) => {
      const fetcher = vi.fn().mockResolvedValue(feeResponse());
      const result = await resolveStandardCctpFee(
        { sourceCode, destinationCode: HUB, amount: 1_000_000n },
        { fetcher, retries: 0 },
      );
      expect(result.maxFee).toBe(0n);
      expect(fetcher).toHaveBeenCalledWith(
        `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/${sourceDomain}/26`,
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    },
  );

  it.each(SPOKES.map((network) => [network.code, network.cctpDomain] as const))(
    "Arc -> %s remains registry-driven",
    async (destinationCode, destinationDomain) => {
      const fetcher = vi.fn().mockResolvedValue(feeResponse());
      const result = await resolveStandardCctpFee(
        {
          sourceCode: HUB,
          destinationCode: destinationCode as BridgeTestnetCode,
          amount: 1_000_000n,
        },
        { fetcher, retries: 0 },
      );
      expect(result.finalityThreshold).toBe(2000);
      expect(fetcher.mock.calls[0]?.[0]).toContain(`/26/${destinationDomain}`);
    },
  );

  it("accepts an exact zero Standard Transfer fee", async () => {
    const result = await resolveStandardCctpFee(
      {
        sourceCode: "ETH-SEPOLIA",
        destinationCode: HUB,
        amount: 5_000_000n,
      },
      { fetcher: vi.fn().mockResolvedValue(feeResponse(0)), retries: 0 },
    );
    expect(result.minimumFeeBps).toBe("0");
    expect(result.maxFee).toBe(0n);
  });

  it("selects threshold 2000 and safely rounds basis points into USDC subunits", async () => {
    const result = await resolveStandardCctpFee(
      {
        sourceCode: "BASE-SEPOLIA",
        destinationCode: HUB,
        amount: 1_000_001n,
      },
      { fetcher: vi.fn().mockResolvedValue(feeResponse(1.3)), retries: 0 },
    );
    expect(result.finalityThreshold).toBe(2000);
    expect(result.minimumFeeBps).toBe("1.3");
    expect(result.maxFee).toBe(calculateCctpMaxFee(1_000_001n, "1.3"));
    expect(result.maxFee).toBe(131n);
  });

  it.each([
    ["missing", [{ finalityThreshold: 1000, minimumFee: 1 }]],
    [
      "duplicate",
      [
        { finalityThreshold: 2000, minimumFee: 0 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ],
    ],
    ["wrong", [{ finalityThreshold: 3000, minimumFee: 0 }]],
  ])("fails explicitly for a %s Standard fee entry", async (_name, entries) => {
    await expect(
      resolveStandardCctpFee(
        {
          sourceCode: "OP-SEPOLIA",
          destinationCode: HUB,
          amount: 1_000_000n,
        },
        { fetcher: vi.fn().mockResolvedValue(feeResponse(0, entries)), retries: 0 },
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it.each([
    [404, "NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "SERVICE_UNAVAILABLE"],
    [503, "SERVICE_UNAVAILABLE"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    await expect(
      resolveStandardCctpFee(
        {
          sourceCode: "ARB-SEPOLIA",
          destinationCode: HUB,
          amount: 1_000_000n,
        },
        {
          fetcher: vi.fn().mockResolvedValue(new Response("", { status })),
          retries: 0,
        },
      ),
    ).rejects.toMatchObject({ code });
  });

  it("maps malformed JSON separately", async () => {
    await expect(
      resolveStandardCctpFee(
        {
          sourceCode: "ETH-SEPOLIA",
          destinationCode: HUB,
          amount: 1_000_000n,
        },
        {
          fetcher: vi.fn().mockResolvedValue(new Response("not-json")),
          retries: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("maps a finite request timeout separately", async () => {
    const fetcher = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
    );
    await expect(
      resolveStandardCctpFee(
        {
          sourceCode: "ETH-SEPOLIA",
          destinationCode: HUB,
          amount: 1_000_000n,
        },
        { fetcher: fetcher as typeof fetch, retries: 0, timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("maps caller cancellation separately", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveStandardCctpFee(
        {
          sourceCode: "ETH-SEPOLIA",
          destinationCode: HUB,
          amount: 1_000_000n,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("ignores a stale response after the route changes", async () => {
    const releases: Array<(value: Awaited<ReturnType<typeof resolveStandardCctpFee>>) => void> = [];
    const resolver = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof resolveStandardCctpFee>>>(
          (resolve) => releases.push(resolve),
        ),
    );
    const coordinator = createCctpFeeRequestCoordinator(resolver as never);
    const first = coordinator.run({
      sourceCode: "ETH-SEPOLIA",
      destinationCode: HUB,
      amount: 1_000_000n,
    });
    const second = coordinator.run({
      sourceCode: "BASE-SEPOLIA",
      destinationCode: HUB,
      amount: 1_000_000n,
    });
    releases[1]({ maxFee: 0n } as never);
    await expect(second).resolves.toMatchObject({ state: "current" });
    releases[0]({ maxFee: 1n } as never);
    await expect(first).resolves.toEqual({ state: "stale" });
  });

  it("caches only successful fee data by exact route", async () => {
    const fetcher = vi.fn().mockImplementation(async () => feeResponse());
    await resolveStandardCctpFee(
      { sourceCode: "ETH-SEPOLIA", destinationCode: HUB, amount: 1_000_000n },
      { fetcher, retries: 0, now: () => 1_000 },
    );
    const cached = await resolveStandardCctpFee(
      { sourceCode: "ETH-SEPOLIA", destinationCode: HUB, amount: 2_000_000n },
      { fetcher, retries: 0, now: () => 1_100 },
    );
    await resolveStandardCctpFee(
      { sourceCode: "BASE-SEPOLIA", destinationCode: HUB, amount: 1_000_000n },
      { fetcher, retries: 0, now: () => 1_100 },
    );
    expect(cached.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.flat().join(" ")).not.toContain("/api/");
  });

  it("rejects unsupported non-hub routes before any request", async () => {
    const fetcher = vi.fn();
    await expect(
      resolveStandardCctpFee(
        {
          sourceCode: "ETH-SEPOLIA",
          destinationCode: "BASE-SEPOLIA",
          amount: 1_000_000n,
        },
        { fetcher },
      ),
    ).rejects.toEqual(expect.any(CctpFeeError));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
