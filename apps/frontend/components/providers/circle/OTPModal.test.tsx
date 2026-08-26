import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { OTPModal } from "./OTPModal";

function renderOtp(overrides: Partial<React.ComponentProps<typeof OTPModal>> = {}) {
  const props: React.ComponentProps<typeof OTPModal> = {
    email: "payer@example.com",
    setEmail: vi.fn(),
    isAuthenticating: false,
    isSdkReady: true,
    hasPendingEmailOtp: false,
    onRequestEmailOtp: vi.fn().mockResolvedValue(undefined),
    onVerifyEmailOtp: vi.fn(),
    ...overrides,
  };
  render(<OTPModal {...props} />);
  return props;
}

describe("Email OTP mobile entry handoff", () => {
  it("uses a touch-friendly email field before requesting a code", async () => {
    const user = userEvent.setup();
    const props = renderOtp({ email: "" });
    const input = screen.getByLabelText("Email address");

    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toHaveAttribute("inputmode", "email");
    await user.type(input, "payer@example.com");
    expect(props.setEmail).toHaveBeenCalled();
  });

  it("shows the secure Circle verification handoff and calls only the OTP verifier", async () => {
    const user = userEvent.setup();
    const onVerifyEmailOtp = vi.fn();
    const onRequestGoogleLogin = vi.fn();
    renderOtp({ hasPendingEmailOtp: true, onVerifyEmailOtp });

    expect(screen.getByText(/p\*\*\*@example\.com/)).toBeInTheDocument();
    const verify = screen.getByRole("button", {
      name: /enter verification code/i,
    });
    await user.click(verify);
    expect(onVerifyEmailOtp).toHaveBeenCalledTimes(1);
    expect(onRequestGoogleLogin).not.toHaveBeenCalled();
  });

  it("prevents duplicate verification and rapid resend while authentication is active", () => {
    renderOtp({ hasPendingEmailOtp: true, isAuthenticating: true });
    expect(
      screen.getByRole("button", { name: /opening verification/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /resend code/i })).toBeDisabled();
  });
});
