import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useEmailAuth, type EmailAuthDeps } from "./useEmailAuth";

function dependencies(
  verifyOtp: () => void,
): EmailAuthDeps & { sdk: { verifyOtp: () => void } } {
  const sdk = { verifyOtp };
  return {
    sdk,
    authRequestInFlightRef: { current: false },
    sdkRef: { current: sdk } as EmailAuthDeps["sdkRef"],
    setAuthError: vi.fn(),
    setAuthStatus: vi.fn(),
    setIsAuthenticating: vi.fn(),
    setIsCircleVerificationActive: vi.fn(),
    hasPendingEmailOtp: true,
    handleAuthFailure: vi.fn(),
    ensureDeviceId: vi.fn().mockResolvedValue("device-id"),
    postW3sAction: vi.fn(),
    storeLoginConfig: vi.fn(),
  };
}

describe("useEmailAuth Circle verification surface", () => {
  it("restores WizPay interaction after the Circle iframe closes", async () => {
    const iframe = document.createElement("iframe");
    iframe.id = "sdkIframe";
    const deps = dependencies(() => document.body.appendChild(iframe));
    const { result } = renderHook(() => useEmailAuth(deps));

    act(() => result.current.verifyEmailOtp());
    expect(deps.setIsCircleVerificationActive).toHaveBeenCalledWith(true);
    expect(deps.setIsAuthenticating).toHaveBeenCalledWith(true);

    iframe.remove();
    await waitFor(() =>
      expect(deps.setIsCircleVerificationActive).toHaveBeenLastCalledWith(false),
    );
    expect(deps.setIsAuthenticating).toHaveBeenLastCalledWith(false);
  });

  it("restores the login UI if the SDK cannot open verification", () => {
    const error = new Error("failed to open");
    const deps = dependencies(() => {
      throw error;
    });
    const { result } = renderHook(() => useEmailAuth(deps));

    act(() => result.current.verifyEmailOtp());

    expect(deps.setIsCircleVerificationActive).toHaveBeenLastCalledWith(false);
    expect(deps.setIsAuthenticating).toHaveBeenLastCalledWith(false);
    expect(deps.handleAuthFailure).toHaveBeenCalledWith(error);
  });
});
