import { afterEach, describe, expect, it, vi } from "vitest";
import { backendFetch, readFrontendApiBaseUrl } from "./backend-api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("production frontend API configuration", () => {
  it("reads the canonical URL directly from the bundled environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.wizpay.xyz");

    expect(readFrontendApiBaseUrl()).toBe("https://api.wizpay.xyz");
  });

  it("requires the canonical HTTPS public API URL", () => {
    expect(
      readFrontendApiBaseUrl({
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: "https://backend.example.com",
      }),
    ).toBe("https://backend.example.com");
  });

  it("fails closed when the production URL is missing or an alias is present", () => {
    expect(() => readFrontendApiBaseUrl({ NODE_ENV: "production" })).toThrow(
      "NEXT_PUBLIC_API_URL is required",
    );
    expect(() =>
      readFrontendApiBaseUrl({
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: "https://backend.example.com",
        NEXT_PUBLIC_BACKEND_URL: "https://legacy.example.com",
      }),
    ).toThrow("aliases are not accepted");
  });

  it("rejects credentials and non-local HTTP", () => {
    for (const value of [
      "http://backend.example.com",
      "https://user:secret@backend.example.com",
    ]) {
      expect(() =>
        readFrontendApiBaseUrl({
          NODE_ENV: "production",
          NEXT_PUBLIC_API_URL: value,
        }),
      ).toThrow("credential-free HTTPS");
    }
  });

  it("retains the localhost default only outside production", () => {
    expect(readFrontendApiBaseUrl({ NODE_ENV: "development" })).toBe(
      "http://localhost:4000",
    );
  });
});

describe("deliberate Phase 9 backend switch and rollback", () => {
  it("bundles exactly one target for switch and a deliberate rebuilt rollback", () => {
    for (const target of [
      "https://wizpay-api-serverless.vercel.app",
      "https://api.wizpay.xyz",
    ]) {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PUBLIC_API_URL", target);
      expect(readFrontendApiBaseUrl()).toBe(target);
    }
  });
  it("never retries a failed target request against the VPS or another database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "NEXT_PUBLIC_API_URL",
      "https://wizpay-api-serverless.vercel.app",
    );
    const request = vi.fn().mockRejectedValue(new Error("target unavailable"));
    vi.stubGlobal("fetch", request);
    await expect(backendFetch("/activities")).rejects.toThrow(
      "target unavailable",
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(
      "https://wizpay-api-serverless.vercel.app/activities",
    );
  });
  it("rejects simultaneous production aliases rather than splitting traffic", () => {
    expect(() =>
      readFrontendApiBaseUrl({
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: "https://wizpay-api-serverless.vercel.app",
        NEXT_PUBLIC_BACKEND_URL: "https://api.wizpay.xyz",
      }),
    ).toThrow("aliases are not accepted");
  });
});
