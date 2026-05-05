import { NextResponse } from "next/server";

const ALLOWED_HOSTS = new Set([
  "api.circle.com",
  "iris-api.circle.com",
  "iris-api-sandbox.circle.com",
]);

function isAllowedPath(url: URL) {
  if (url.host === "api.circle.com") {
    return url.pathname.startsWith("/v1/stablecoinKits/");
  }

  if (
    url.host === "iris-api.circle.com" ||
    url.host === "iris-api-sandbox.circle.com"
  ) {
    return (
      url.pathname.startsWith("/v2/messages/") ||
      url.pathname.startsWith("/v2/burn/")
    );
  }

  return false;
}

function pickForwardHeaders(headers: Record<string, string>) {
  const allow = new Set([
    "accept",
    "content-type",
    "idempotency-key",
    "x-request-id",
    "x-correlation-id",
    "circle-user-token",
    "x-user-token",
  ]);

  const out = new Headers();

  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const key = rawKey.toLowerCase();

    if (!allow.has(key)) {
      continue;
    }

    if (typeof rawValue !== "string" || rawValue.length === 0) {
      continue;
    }

    out.set(key, rawValue);
  }

  return out;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { url, method = "GET", headers = {}, body: rawBody } = body ?? {};

    if (typeof url !== "string" || url.length === 0) {
      return NextResponse.json({ error: "Missing target url" }, { status: 400 });
    }

    const target = new URL(url);

    if (!ALLOWED_HOSTS.has(target.host) || !isAllowedPath(target)) {
      return NextResponse.json(
        { error: "Circle target is not allowed" },
        { status: 403 }
      );
    }

    const upperMethod = String(method).toUpperCase();
    const allowedMethods = new Set(["GET", "POST", "HEAD"]);
    if (!allowedMethods.has(upperMethod)) {
      return NextResponse.json(
        { error: `Method not allowed: ${upperMethod}` },
        { status: 405 }
      );
    }

    const upstreamHeaders = pickForwardHeaders(headers as Record<string, string>);

    // NOTE: Do NOT inject CIRCLE_API_KEY here.
    // This proxy is used exclusively for CCTP V2 attestation polling
    // (iris-api-sandbox.circle.com /v2/messages/*) which is a public endpoint
    // that does not require authentication. API keys must stay in the backend.

    const upstreamResponse = await fetch(target.toString(), {
      method: upperMethod,
      headers: upstreamHeaders,
      body:
        upperMethod === "GET" || upperMethod === "HEAD"
          ? undefined
          : typeof rawBody === "string"
            ? rawBody
            : JSON.stringify(rawBody ?? {}),
      cache: "no-store",
    });

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) {
      responseHeaders.set("content-type", contentType);
    }
    responseHeaders.set("cache-control", "no-store");

    const responseBody = await upstreamResponse.arrayBuffer();

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
