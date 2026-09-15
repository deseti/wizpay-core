import { describe, expect, it } from "vitest";
import {
  frontendSecurityHeaderRules,
  PRODUCTION_SECURITY_HEADERS,
} from "./security-headers";

describe("production browser security headers", () => {
  it("sets the complete header set on every response", () => {
    expect(frontendSecurityHeaderRules()).toEqual([
      { source: "/(.*)", headers: [...PRODUCTION_SECURITY_HEADERS] },
    ]);
    expect(new Set(PRODUCTION_SECURITY_HEADERS.map(({ key }) => key))).toEqual(
      new Set([
        "Content-Security-Policy",
        "Strict-Transport-Security",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
      ]),
    );
  });

  it("keeps production CSP free of unsafe-eval and wildcard origins while allowing required Circle authentication", () => {
    const csp =
      PRODUCTION_SECURITY_HEADERS.find(
        ({ key }) => key === "Content-Security-Policy",
      )?.value ?? "";
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https:\/\/\*\./);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://pw-auth.circle.com");
    expect(csp).toContain("wss://relay.walletconnect.com");
  });

  it("adds only the exact configured HTTPS backend origin", () => {
    const csp = frontendSecurityHeaderRules({
      NEXT_PUBLIC_API_URL: "https://api.wizpay.example/v1",
      NEXT_PUBLIC_CIRCLE_PASSKEY_MODULAR_RPC_URL_ARC_TESTNET:
        "https://circle-rpc.wizpay.example/rpc",
    })[0].headers[0].value;
    expect(csp).toContain("connect-src 'self' https://api.wizpay.example ");
    expect(csp).toContain("https://circle-rpc.wizpay.example");
    expect(csp).not.toContain("https://api.wizpay.example/v1");
    expect(csp).not.toContain("https://circle-rpc.wizpay.example/rpc");
    expect(() =>
      frontendSecurityHeaderRules({
        NEXT_PUBLIC_API_URL: "http://api.wizpay.example",
      }),
    ).toThrow("credential-free HTTPS");
  });
});
