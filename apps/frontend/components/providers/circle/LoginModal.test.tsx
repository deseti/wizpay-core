import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LoginModal } from "./LoginModal";

function props(overrides: Partial<React.ComponentProps<typeof LoginModal>> = {}) {
  return {
    authError: null,
    authStatus: null,
    canUseGoogle: true,
    canUsePasskey: false,
    hasPendingEmailOtp: false,
    isSdkReady: true,
    isAuthenticating: false,
    isCircleVerificationActive: false,
    isOpen: true,
    onClose: vi.fn(),
    onRequestEmailOtp: vi.fn().mockResolvedValue(undefined),
    onRequestGoogleLogin: vi.fn().mockResolvedValue(undefined),
    onRequestPasskeyLogin: vi.fn().mockResolvedValue(undefined),
    onRequestPasskeyRegistration: vi.fn().mockResolvedValue(undefined),
    onVerifyEmailOtp: vi.fn(),
    passkeyUnavailableReason: null,
    ...overrides,
  } satisfies React.ComponentProps<typeof LoginModal>;
}

describe("LoginModal Circle interaction ownership", () => {
  it("releases the Radix modal pointer and focus trap while Circle owns verification", async () => {
    const initial = props();
    const { rerender } = render(<LoginModal {...initial} />);

    await waitFor(() => expect(document.body.style.pointerEvents).toBe("none"));
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-hidden");

    rerender(
      <LoginModal {...initial} isCircleVerificationActive={true} />,
    );

    await waitFor(() => expect(document.body.style.pointerEvents).toBe(""));
    expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByRole("dialog", { hidden: true })).toHaveClass(
      "pointer-events-none",
    );
  });

  it("retains the entered email when Circle interaction is suspended and restored", async () => {
    const user = userEvent.setup();
    const initial = props();
    const { rerender } = render(<LoginModal {...initial} />);
    const email = screen.getByLabelText("Email address");
    await user.type(email, "payer@example.com");

    rerender(<LoginModal {...initial} isCircleVerificationActive={true} />);
    rerender(<LoginModal {...initial} isCircleVerificationActive={false} />);

    expect(screen.getByLabelText("Email address")).toHaveValue(
      "payer@example.com",
    );
  });
});
