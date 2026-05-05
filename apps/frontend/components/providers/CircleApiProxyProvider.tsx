"use client";

import { useEffect } from "react";

const PROXIED_HOSTS = new Set([
  "api.circle.com",
  "iris-api.circle.com",
  "iris-api-sandbox.circle.com",
]);
const CIRCLE_API_PROXY_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_CIRCLE_API_PROXY_ENABLED ?? "")
    .trim()
    .toLowerCase()
);

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") {
      return new URL(input, window.location.origin);
    }

    if (input instanceof URL) {
      return new URL(input.toString(), window.location.origin);
    }

    if (typeof Request !== "undefined" && input instanceof Request) {
      return new URL(input.url, window.location.origin);
    }
  } catch {
    return null;
  }

  return null;
}

function shouldProxyCircleRequest(url: URL) {
  if (!PROXIED_HOSTS.has(url.host)) {
    return false;
  }

  return (
    url.pathname.startsWith("/v1/stablecoinKits/") ||
    url.pathname.startsWith("/v2/messages/") ||
    url.pathname.startsWith("/v2/burn/")
  );
}

export function CircleApiProxyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!CIRCLE_API_PROXY_ENABLED) {
      return;
    }

    const originalFetch = window.fetch.bind(window);
    let isProxyHealthy = true;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const targetUrl = resolveRequestUrl(input);

      if (!targetUrl || !shouldProxyCircleRequest(targetUrl)) {
        return originalFetch(input, init);
      }

      // If the local proxy route was unavailable earlier (404/5xx), keep the
      // Circle SDK path working by falling back to direct requests.
      if (!isProxyHealthy) {
        return originalFetch(input, init);
      }

      const request = new Request(input, init);

      const headers = Object.fromEntries(request.headers.entries());
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.clone().text();

      try {
        const proxiedResponse = await originalFetch("/api/circle/proxy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: targetUrl.toString(),
            method: request.method,
            headers,
            body,
          }),
          signal: request.signal,
        });

        if (proxiedResponse.status === 404 || proxiedResponse.status >= 500) {
          isProxyHealthy = false;
          return originalFetch(input, init);
        }

        return proxiedResponse;
      } catch {
        isProxyHealthy = false;
        return originalFetch(input, init);
      }
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return children;
}