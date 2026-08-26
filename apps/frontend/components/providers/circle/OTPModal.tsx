import React, { useEffect, useState } from "react";
import { ArrowRight, Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function OTPModal({
  email,
  setEmail,
  isAuthenticating,
  isSdkReady,
  hasPendingEmailOtp,
  onRequestEmailOtp,
  onVerifyEmailOtp,
}: {
  email: string;
  setEmail: (email: string) => void;
  isAuthenticating: boolean;
  isSdkReady: boolean;
  hasPendingEmailOtp: boolean;
  onRequestEmailOtp: (email: string) => Promise<void>;
  onVerifyEmailOtp: () => void;
}) {
  const [resendSeconds, setResendSeconds] = useState(
    hasPendingEmailOtp ? 30 : 0,
  );

  useEffect(() => {
    if (resendSeconds <= 0) return;

    const timer = window.setTimeout(
      () => setResendSeconds((current) => Math.max(0, current - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  const maskedEmail = maskEmail(email);

  return (
    <section
      aria-labelledby="email-otp-title"
      className="rounded-2xl border border-border/40 bg-card/40 p-4 sm:p-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
          <Mail className="size-4" aria-hidden="true" />
        </div>
        <div>
          <h2 id="email-otp-title" className="text-sm font-semibold">
            {hasPendingEmailOtp ? "Check your email" : "Continue with email"}
          </h2>
          <p className="text-xs text-muted-foreground/70">
            {hasPendingEmailOtp
              ? `We sent a verification code to ${maskedEmail}.`
              : "Receive a secure one-time verification code."}
          </p>
        </div>
      </div>

      {!hasPendingEmailOtp ? (
        <div className="space-y-3">
          <label className="sr-only" htmlFor="circle-login-email">
            Email address
          </label>
          <Input
            autoCapitalize="none"
            autoComplete="email"
            className="h-11 text-base"
            id="circle-login-email"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            spellCheck={false}
            type="email"
            value={email}
          />
          <Button
            className="h-11 w-full"
            disabled={isAuthenticating || !email.trim() || !isSdkReady}
            onClick={() => {
              setResendSeconds(30);
              void onRequestEmailOtp(email);
            }}
          >
            {isAuthenticating ? "Sending code..." : "Send verification code"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-muted-foreground" role="status">
            Open Circle&apos;s secure verification screen and enter the numeric
            code from your email. The code is never stored by WizPay.
          </p>
          <Button
            className="h-12 w-full text-base"
            disabled={isAuthenticating || !isSdkReady}
            onClick={onVerifyEmailOtp}
          >
            {isAuthenticating ? "Opening verification..." : "Enter verification code"}
            {!isAuthenticating ? <ArrowRight aria-hidden="true" /> : null}
          </Button>
          <Button
            className="h-10 w-full"
            disabled={isAuthenticating || resendSeconds > 0 || !isSdkReady}
            onClick={() => {
              setResendSeconds(30);
              void onRequestEmailOtp(email);
            }}
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" />
            {resendSeconds > 0
              ? `Resend code in ${resendSeconds}s`
              : "Resend code"}
          </Button>
          <p className="text-center text-xs text-muted-foreground/60">
            Circle securely validates the code and restores your User-Controlled Wallet.
          </p>
        </div>
      )}
    </section>
  );
}

function maskEmail(value: string) {
  const [localPart, domain] = value.trim().split("@");
  if (!localPart || !domain) return "your email address";
  return `${localPart.slice(0, 1)}***@${domain}`;
}
