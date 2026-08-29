export const CIRCLE_SDK_IMPORT_TIMEOUT_MS = 15_000;
export const CIRCLE_DEVICE_ID_TIMEOUT_MS = 12_000;
export const CIRCLE_ACTION_TIMEOUT_MS = 20_000;
export const CIRCLE_EXECUTE_TIMEOUT_MS = 120_000;
export const CIRCLE_WALLET_LOAD_TIMEOUT_MS = 30_000;
export const CIRCLE_DOCUMENT_START_TIMEOUT_MS = 4_000;

export type CircleInitializationPhase =
  | "waiting_for_document"
  | "loading_sdk"
  | "restoring_session"
  | "refreshing_session"
  | "initializing_wallets"
  | "syncing_wallets"
  | "loading_balances"
  | "ready"
  | "recoverable_error"
  | "reauthentication_required";

export class CircleTimeoutError extends Error {
  constructor(
    readonly phase: CircleInitializationPhase,
    timeoutMs: number,
  ) {
    super(
      `Circle ${phase.replaceAll("_", " ")} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
    );
    this.name = "CircleTimeoutError";
  }
}

export function withCircleTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: CircleInitializationPhase,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new CircleTimeoutError(phase, timeoutMs)),
      timeoutMs,
    );
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

export async function waitForBoundedDocumentStart(
  timeoutMs = CIRCLE_DOCUMENT_START_TIMEOUT_MS,
) {
  if (typeof window === "undefined" || document.readyState !== "loading")
    return "ready" as const;
  return new Promise<"dom_ready" | "timeout">((resolve) => {
    const finish = (result: "dom_ready" | "timeout") => {
      window.clearTimeout(timer);
      document.removeEventListener("DOMContentLoaded", onReady);
      resolve(result);
    };
    const onReady = () => finish("dom_ready");
    const timer = window.setTimeout(() => finish("timeout"), timeoutMs);
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
  });
}

export function readJwtExpiryMs(token: string) {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      window.atob(
        normalized.padEnd(
          normalized.length + ((4 - (normalized.length % 4)) % 4),
          "=",
        ),
      ),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function shouldRefreshCircleToken(
  userToken: string,
  now = Date.now(),
  skewMs = 5 * 60_000,
) {
  const expiry = readJwtExpiryMs(userToken);
  return expiry !== null && expiry <= now + skewMs;
}
