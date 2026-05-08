import React, { useState } from "react";
import { Mail } from "lucide-react";
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
  return (
    <div className="rounded-2xl border border-border/40 bg-card/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Mail className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold">Email OTP</p>
      </div>
      <div className="space-y-3">
        <Input
          autoComplete="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          type="email"
          value={email}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            disabled={isAuthenticating || !email.trim() || !isSdkReady}
            variant="outline"
            onClick={() => {
              void onRequestEmailOtp(email);
            }}
          >
            Send OTP
          </Button>
          <Button
            disabled={!hasPendingEmailOtp || isAuthenticating}
            onClick={onVerifyEmailOtp}
          >
            Verify OTP
          </Button>
        </div>
      </div>
    </div>
  );
}
