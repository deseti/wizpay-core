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
  bridge: false,
  swap: false,
  crossTokenPayroll: false,
  crossTokenInvoice: false,
  stableFx: false,
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
    process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK = "arc-testnet";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK = originalNetwork;
  });

  it("accepts only backend capabilities for the selected network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          data: {
            network: "arc-testnet",
            capabilities: { ...allFalse, send: true },
          },
        }),
      ),
    );
    await expect(fetchEffectiveCapabilities()).resolves.toMatchObject({
      capabilities: { send: true },
    });
  });

  it("rejects mismatched Testnet data instead of falling back across networks", async () => {
    const selected = process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK;
    process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK = "arc-mainnet";
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          data: {
            network: "arc-testnet",
            capabilities: { ...allFalse, send: true },
          },
        }),
      ),
    );
    await expect(fetchEffectiveCapabilities()).rejects.toThrow(
      "does not match",
    );
    process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK = selected;
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
        response({ data: { network: "arc-testnet", capabilities: allFalse } }),
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
