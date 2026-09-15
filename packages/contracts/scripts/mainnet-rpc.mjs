import { setTimeout as delay } from "node:timers/promises";

export function normalizeRpcUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("RPC URL is invalid."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error("RPC URL must be a credential-free canonical HTTPS URL.");
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.port === "443") parsed.port = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.href;
}

export function createRpcClient(url, { fetchImpl = fetch, retries = 2, backoffMs = 250 } = {}) {
  const canonicalUrl = normalizeRpcUrl(url);
  let id = 0;
  return Object.freeze({
    url: canonicalUrl,
    async request(method, params = []) {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const response = await fetchImpl(canonicalUrl, {
            method: "POST",
            redirect: "follow",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.url && normalizeRpcUrl(response.url) !== canonicalUrl) throw new Error("RPC redirected to a different endpoint alias");
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          if (!payload || typeof payload !== "object") throw new Error("JSON-RPC response is malformed");
          if (payload.error) throw new Error(`${payload.error.code}: ${payload.error.message}`);
          if (payload.result === undefined) throw new Error("JSON-RPC result is missing");
          return payload.result;
        } catch (error) {
          lastError = error;
          if (attempt < retries) await delay(backoffMs * 2 ** attempt);
        }
      }
      throw new Error(`${method} failed after bounded retries: ${lastError?.message ?? "unknown error"}`);
    },
  });
}

export function quantity(value, label) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error(`${label} is not a canonical JSON-RPC quantity.`);
  return BigInt(value);
}

export function rpcBlockTag(value) {
  if (typeof value !== "bigint" || value < 0n) throw new Error("Block tag is invalid.");
  return `0x${value.toString(16)}`;
}
