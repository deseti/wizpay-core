import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBridgeIntent,
  fetchBridgeQuote,
  getBridgeAttestation,
} from "./bridge-service";

function response(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data }),
  } as Response);
}

describe("bridge-service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates intents through the backend lifecycle", async () => {
    const fetchMock = vi.fn(() => response({ id: "intent-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createBridgeIntent({
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        sourceCode: "ARC-MAINNET",
        destinationCode: "BASE-MAINNET",
        walletAddress: "0x1111111111111111111111111111111111111111",
        recipientAddress: "0x1111111111111111111111111111111111111111",
        amount: "1000000",
        maxFee: "1000",
        minFinalityThreshold: 2000,
      }),
    ).resolves.toMatchObject({ id: "intent-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/bridge/intents"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("polls attestations through the backend", async () => {
    const fetchMock = vi.fn(() => response({ status: "attestation_ready" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getBridgeAttestation("intent-1", "0x1111111111111111111111111111111111111111"),
    ).resolves.toMatchObject({ status: "attestation_ready" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/bridge/intents/intent-1/attestation"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fetches authoritative quotes without a transfer-mode selector", async () => {
    const fetchMock = vi.fn(() =>
      response({
        transferMode: "fast",
        minFinalityThreshold: 1000,
        maxFeeSuggested: "396",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchBridgeQuote({
        sourceCode: "BASE-MAINNET",
        destinationCode: "ARC-MAINNET",
        amount: "10000000",
      }),
    ).resolves.toMatchObject({ transferMode: "fast" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/bridge/quote"),
      expect.anything(),
    );
  });
});
