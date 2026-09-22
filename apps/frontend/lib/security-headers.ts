function httpsOrigin(value: string, label: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL for CSP.`);
  }
  return url.origin;
}

function backendConnectOrigin(environment: Record<string, string | undefined>) {
  const value = environment.NEXT_PUBLIC_API_URL;
  const legacyPublicVariables = [
    environment.NEXT_PUBLIC_BACKEND_API_BASE_URL,
    environment.NEXT_PUBLIC_BACKEND_URL,
    environment.NEXT_PUBLIC_INVOICE_API_PREFIX,
    environment.NEXT_PUBLIC_WIZPAY_AGENTIC_NANO_ADDRESS,
  ];
  if (
    environment.NODE_ENV === "production" &&
    legacyPublicVariables.some((candidate) => Boolean(candidate?.trim()))
  ) {
    throw new Error(
      "Legacy NEXT_PUBLIC backend configuration is not accepted in production.",
    );
  }
  if (!value) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "NEXT_PUBLIC_API_URL is required to build the production CSP.",
      );
    }
    return null;
  }

  const url = new URL(value);
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    !url.username &&
    !url.password
  ) {
    return url.origin;
  }

  return httpsOrigin(value, "Production backend URL");
}

function contentSecurityPolicy(
  environment: Record<string, string | undefined>,
) {
  const backendOrigin = backendConnectOrigin(environment);
  const dynamicConnectOrigins = [...new Set([backendOrigin])]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://api.qrserver.com https://secure.walletconnect.com",
    "font-src 'self' data:",
    `connect-src 'self'${dynamicConnectOrigins ? ` ${dynamicConnectOrigins}` : ""} https://rpc.mainnet.arc.io https://explorer.arc.io https://rpc.walletconnect.org https://pulse.walletconnect.org https://api.web3modal.org https://secure.walletconnect.org https://verify.walletconnect.org wss://relay.walletconnect.com`,
    "frame-src 'self' https://verify.walletconnect.org",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function productionSecurityHeaders(
  environment: Record<string, string | undefined> = {},
) {
  return Object.freeze([
    {
      key: "Content-Security-Policy",
      value: contentSecurityPolicy(environment),
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self)",
    },
  ]);
}

export const PRODUCTION_SECURITY_HEADERS = productionSecurityHeaders();

export function frontendSecurityHeaderRules(
  environment: Record<string, string | undefined> = {},
) {
  return [
    { source: "/(.*)", headers: [...productionSecurityHeaders(environment)] },
  ];
}
