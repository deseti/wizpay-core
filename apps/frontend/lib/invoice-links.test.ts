import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getConfiguredPublicAppOrigin,
  getInvoiceCheckoutUrl,
} from "@/lib/invoice-links";

describe("invoice checkout URL policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows configured HTTPS and localhost HTTP origins only", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL",
      "https://pay.wizpay.example/path",
    );
    expect(getConfiguredPublicAppOrigin()).toBe("https://pay.wizpay.example");
    expect(getInvoiceCheckoutUrl("abcdefghijklmnopqrstuv")).toBe(
      "https://pay.wizpay.example/pay/abcdefghijklmnopqrstuv",
    );
    vi.stubEnv("NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL", "http://localhost:3000");
    expect(getConfiguredPublicAppOrigin()).toBe("http://localhost:3000");
  });

  it("rejects non-local HTTP, credentials, query data, and internal IDs", () => {
    vi.stubEnv("NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL", "http://pay.example.com");
    expect(() => getConfiguredPublicAppOrigin()).toThrow("HTTPS");
    vi.stubEnv(
      "NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL",
      "https://user:pass@pay.example.com",
    );
    expect(() => getConfiguredPublicAppOrigin()).toThrow("credentials");
    vi.stubEnv(
      "NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL",
      "https://pay.example.com?redirect=evil",
    );
    expect(() => getConfiguredPublicAppOrigin()).toThrow("query");
    expect(() => getInvoiceCheckoutUrl("internal-uuid")).toThrow(
      "Invalid public",
    );
  });
});
