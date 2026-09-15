const CONFIGURED_CONNECT_URL_KEYS = [
  "NEXT_PUBLIC_CIRCLE_TESTNET_PASSKEY_CLIENT_URL",
  "NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_URL",
  "NEXT_PUBLIC_CIRCLE_PASSKEY_MODULAR_RPC_URL_ARC_TESTNET",
  "NEXT_PUBLIC_CIRCLE_PASSKEY_MODULAR_RPC_URL_ETH_SEPOLIA",
  "NEXT_PUBLIC_ARC_TESTNET_RPC_URL",
  "NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL",
  "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
  "NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL",
  "NEXT_PUBLIC_OP_SEPOLIA_RPC_URL",
  "NEXT_PUBLIC_MONAD_TESTNET_RPC_URL",
] as const;

function httpsOrigin(value: string, label: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL for CSP.`);
  }
  return url.origin;
}

function backendConnectOrigin(environment: Record<string, string | undefined>) {
  const value =
    environment.NEXT_PUBLIC_API_URL ??
    environment.NEXT_PUBLIC_BACKEND_API_BASE_URL ??
    environment.NEXT_PUBLIC_BACKEND_URL ??
    environment.BACKEND_API_BASE_URL;
  if (!value) return null;
  return httpsOrigin(value, "Production backend URL");
}

function contentSecurityPolicy(environment: Record<string, string | undefined>) {
  const backendOrigin = backendConnectOrigin(environment);
  const configuredOrigins = CONFIGURED_CONNECT_URL_KEYS.flatMap((key) => {
    const value = environment[key]?.trim();
    return value ? [httpsOrigin(value, key)] : [];
  });
  const dynamicConnectOrigins = [...new Set([backendOrigin, ...configuredOrigins])]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return [
    "default-src 'self'",
    // Next 15 static output emits inline hydration/bootstrap scripts. A nonce
    // would force dynamic rendering, so unsafe-inline is limited to this one
    // directive; unsafe-eval and wildcard origins remain forbidden.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://api.qrserver.com https://secure.walletconnect.com",
    "font-src 'self' data:",
    `connect-src 'self'${dynamicConnectOrigins ? ` ${dynamicConnectOrigins}` : ""} https://api.circle.com https://iris-api.circle.com https://iris-api-sandbox.circle.com https://modular-sdk.circle.com https://rpc.walletconnect.org https://pulse.walletconnect.org https://api.web3modal.org https://secure.walletconnect.org https://verify.walletconnect.org wss://relay.walletconnect.com https://rpc.testnet.arc.io https://ethereum-sepolia-rpc.publicnode.com https://ethereum-sepolia.publicnode.com`,
    "frame-src 'self' https://pw-auth.circle.com https://verify.walletconnect.org",
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
    { key: "Content-Security-Policy", value: contentSecurityPolicy(environment) },
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
