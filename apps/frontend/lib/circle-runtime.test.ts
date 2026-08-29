import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CIRCLE_DOCUMENT_START_TIMEOUT_MS,
  CircleTimeoutError,
  shouldRefreshCircleToken,
  waitForBoundedDocumentStart,
  withCircleTimeout,
} from "./circle-runtime";
import {
  isDefinitiveCircleRefreshFailure,
  mergeCircleRefreshedSession,
} from "@/services/circle-auth.service";

function jwt(exp: number) {
  const encoded = window
    .btoa(JSON.stringify({ exp }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `header.${encoded}.signature`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Circle bounded runtime", () => {
  it("proceeds when document readiness is delayed instead of waiting for window.load", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const waiting = waitForBoundedDocumentStart(25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(waiting).resolves.toBe("timeout");
    expect(CIRCLE_DOCUMENT_START_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("resumes hidden startup when the document becomes visible", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const waiting = waitForBoundedDocumentStart(1_000);
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await expect(waiting).resolves.toBe("dom_ready");
  });

  it("times out a stalled SDK phase and permits a later retry", async () => {
    vi.useFakeTimers();
    const first = withCircleTimeout(
      new Promise<string>(() => {}),
      20,
      "loading_sdk",
    );
    const expectation =
      expect(first).rejects.toBeInstanceOf(CircleTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    await expect(
      withCircleTimeout(Promise.resolve("ready"), 20, "loading_sdk"),
    ).resolves.toBe("ready");
  });

  it("refreshes before JWT expiry and stores rotated session material", () => {
    expect(
      shouldRefreshCircleToken(jwt(Math.floor(Date.now() / 1000) + 60)),
    ).toBe(true);
    expect(
      mergeCircleRefreshedSession(
        {
          authMethod: "google",
          email: null,
          userToken: "old",
          encryptionKey: "old-key",
          refreshToken: "old-refresh",
        },
        {
          userToken: "new",
          encryptionKey: "new-key",
          refreshToken: "new-refresh",
        },
      ),
    ).toMatchObject({
      userToken: "new",
      encryptionKey: "new-key",
      refreshToken: "new-refresh",
    });
  });

  it("requires reauthentication only for definitive refresh rejection", () => {
    expect(
      isDefinitiveCircleRefreshFailure(
        Object.assign(new Error("expired"), { status: 401 }),
      ),
    ).toBe(true);
    expect(
      isDefinitiveCircleRefreshFailure(new TypeError("Failed to fetch")),
    ).toBe(false);
  });
});
