export class BackendApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}

const DEFAULT_API_BASE_URL = "http://localhost:4000";

export async function backendFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers);
  const apiBaseUrl = resolveBackendBaseUrl();

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (typeof window !== "undefined") {
    console.log("API URL:", apiBaseUrl);
  }

  const response = await fetch(buildBackendUrl(path, apiBaseUrl), {
    ...init,
    cache: "no-store",
    headers,
  });

  const payload = await readJson(response);

  if (!response.ok) {
    const errorPayload = isRecord(payload) ? payload : {};

    throw new BackendApiError(
      getString(errorPayload.error) || `Backend request failed with status ${response.status}`,
      response.status,
      getString(errorPayload.code),
      getString(errorPayload.details)
    );
  }

  if (!isRecord(payload) || !("data" in payload)) {
    throw new BackendApiError(
      "Backend response did not include a data payload.",
      502,
      "BACKEND_EMPTY_RESPONSE"
    );
  }

  return payload.data as T;
}

function resolveBackendBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
    process.env.BACKEND_API_BASE_URL ||
    process.env.API_URL ||
    DEFAULT_API_BASE_URL
  );
}

function buildBackendUrl(path: string, baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  return new URL(path.replace(/^\//, ""), normalizedBaseUrl).toString();
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}