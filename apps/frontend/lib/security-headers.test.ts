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

  it("keeps production CSP free of unsafe-eval and wildcard origins while allowing Mainnet execution", () => {
    const csp =
      PRODUCTION_SECURITY_HEADERS.find(
        ({ key }) => key === "Content-Security-Policy",
      )?.value ?? "";
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https:\/\/\*\./);
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain(
      "img-src 'self' data: blob: https://api.qrserver.com https://secure.walletconnect.com",
    );
    expect(csp).toContain("frame-src 'self' https://verify.walletconnect.org");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("https://rpc.mainnet.arc.io");
    expect(csp).toContain("wss://relay.walletconnect.com");
    expect(csp).not.toContain("api.circle.com");
    expect(csp.toLowerCase()).not.toContain("testnet");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("fonts.reown.com");
    expect(csp).not.toContain("cca-lite.coinbase.com");
    expect(csp).not.toContain("font-src *");
    expect(csp).not.toContain("connect-src *");
    expect(csp).not.toContain("default-src *");
  });

  it("adds only the exact configured HTTPS backend origin", () => {
    const csp = frontendSecurityHeaderRules({
      NEXT_PUBLIC_API_URL: "https://api.wizpay.example/v1",
    })[0].headers[0].value;
    expect(csp).toContain("connect-src 'self' https://api.wizpay.example ");
    expect(csp).not.toContain("https://api.wizpay.example/v1");
    expect(() =>
      frontendSecurityHeaderRules({
        NEXT_PUBLIC_API_URL: "http://api.wizpay.example",
      }),
    ).toThrow("credential-free HTTPS");
  });
});
