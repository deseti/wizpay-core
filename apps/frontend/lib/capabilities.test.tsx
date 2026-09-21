import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityProvider,
  useCapability,
} from "@/components/providers/CapabilityProvider";
import { fetchEffectiveCapabilities } from "./capabilities";

const allFalse = {
  send: false,
  sameTokenPayroll: false,
  invoice: false,
  paymentLink: false,
  liquidity: false,
  bridge: false,
  swap: false,
  crossTokenPayroll: false,
  crossTokenInvoice: false,
  nanoAgentApi: false,
};

function response(data: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 503,
    text: async () => JSON.stringify(data),
  } as Response);
}

describe("frontend capability authority", () => {
  const originalNetwork = process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK = "arc-mainnet";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK = originalNetwork;
  });

  it("accepts only backend capabilities for Arc Mainnet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          data: {
            network: "arc-mainnet",
            capabilities: { ...allFalse, send: true },
          },
        }),
      ),
    );
    await expect(fetchEffectiveCapabilities()).resolves.toMatchObject({
      network: "arc-mainnet",
      capabilities: { send: true },
    });
  });

  it("rejects non-Mainnet capability data instead of falling back across networks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          data: {
            network: "unknown",
            capabilities: { ...allFalse, send: true },
          },
        }),
      ),
    );
    await expect(fetchEffectiveCapabilities()).rejects.toThrow(
      "does not match",
    );
  });

  it("rejects malformed capability payloads without enabling features", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          data: {
            network: "arc-mainnet",
            capabilities: { ...allFalse, send: true, unknownFeature: false },
          },
        }),
      ),
    );
    await expect(fetchEffectiveCapabilities()).rejects.toThrow("malformed");
  });

  it("keeps protected features disabled when capability fetching fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const { result } = renderHook(() => useCapability("send"), {
      wrapper: CapabilityProvider,
    });
    expect(result.current.enabled).toBe(false);
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.enabled).toBe(false);
    expect(() => result.current.assertEnabled()).toThrow("unavailable");
  });

  it("disables an action from effective backend capability data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({ data: { network: "arc-mainnet", capabilities: allFalse } }),
      ),
    );
    function ProtectedAction() {
      const capability = useCapability("send");
      return <button disabled={!capability.enabled}>Send</button>;
    }
    render(
      <CapabilityProvider>
        <ProtectedAction />
      </CapabilityProvider>,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled(),
    );
  });
});
