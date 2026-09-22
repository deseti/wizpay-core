export class BackendApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: string,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}

const DEFAULT_API_BASE_URL = "http://localhost:4000";

type FrontendApiEnvironment = Record<string, string | undefined>;

export function readFrontendApiBaseUrl(
  environment: FrontendApiEnvironment = process.env,
): string {
  const canonical = environment.NEXT_PUBLIC_API_URL?.trim();
  const legacy = [
    environment.NEXT_PUBLIC_BACKEND_API_BASE_URL,
    environment.NEXT_PUBLIC_BACKEND_URL,
    environment.BACKEND_API_BASE_URL,
    environment.API_URL,
  ].filter((value): value is string => Boolean(value?.trim()));

  if (environment.NODE_ENV === "production") {
    if (!canonical) {
      throw new Error(
        "NEXT_PUBLIC_API_URL is required for the production frontend.",
      );
    }
    if (legacy.length > 0) {
      throw new Error(
        "Legacy frontend backend-URL aliases are not accepted in production.",
      );
    }
  }

  const value = canonical || legacy[0]?.trim() || DEFAULT_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The frontend API base URL must be an absolute URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !local)) {
    throw new Error(
      "The frontend API base URL must be credential-free HTTPS except on localhost.",
    );
  }
  return value;
}

export async function backendFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  const apiBaseUrl = resolveBackendBaseUrl();

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(buildBackendUrl(path, apiBaseUrl), {
    ...init,
    cache: "no-store",
    headers,
  });

  const payload = await readJson(response);

  if (!response.ok) {
    const errorPayload = isRecord(payload) ? payload : {};

    // NestJS error responses may have the message in different locations:
    // - { error: "string message" }
    // - { message: "string message", error: "Bad Request" }
    // - { message: { code: "...", message: "..." }, error: "Bad Request" }
    const nestedMessage = isRecord(errorPayload.message)
      ? getString(errorPayload.message.message)
      : getString(errorPayload.message);

    throw new BackendApiError(
      getString(errorPayload.error) !== "Bad Request" &&
        getString(errorPayload.error)
        ? getString(errorPayload.error)!
        : nestedMessage ||
            `Backend request failed with status ${response.status}`,
      response.status,
      getString(errorPayload.code) ||
        (isRecord(errorPayload.message)
          ? getString(errorPayload.message.code)
          : undefined),
      getString(errorPayload.details),
      errorPayload,
    );
  }

  if (!isRecord(payload) || !("data" in payload)) {
    throw new BackendApiError(
      "Backend response did not include a data payload.",
      502,
      "BACKEND_EMPTY_RESPONSE",
      undefined,
      payload,
    );
  }

  return payload.data as T;
}

export function resolveBackendBaseUrl(): string {
  return readFrontendApiBaseUrl();
}

export function buildBackendUrl(path: string, baseUrl: string): string {
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
