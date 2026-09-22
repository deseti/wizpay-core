import { afterEach, describe, expect, it, vi } from "vitest";
import { readFrontendApiBaseUrl } from "./backend-api";

afterEach(() => {
  vi.unstubAllEnvs();
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
