import React, { useState } from "react";
import { LogIn, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OTPModal } from "./OTPModal";
import { ErrorState } from "./ErrorState";

export function LoginModal({
  authError,
  authStatus,
  canUseGoogle,
  canUsePasskey,
  hasPendingEmailOtp,
  isDeviceReady,
  isAuthenticating,
  isOpen,
  onClose,
  onRequestEmailOtp,
  onRequestGoogleLogin,
  onRequestPasskeyLogin,
  onRequestPasskeyRegistration,
  onVerifyEmailOtp,
  passkeyUnavailableReason,
}: {
  authError: string | null;
  authStatus: string | null;
  canUseGoogle: boolean;
  canUsePasskey: boolean;
  hasPendingEmailOtp: boolean;
  isDeviceReady: boolean;
  isAuthenticating: boolean;
  isOpen: boolean;
  onClose: () => void;
  onRequestEmailOtp: (email: string) => Promise<void>;
  onRequestGoogleLogin: () => Promise<void>;
  onRequestPasskeyLogin: () => Promise<void>;
  onRequestPasskeyRegistration: (username: string) => Promise<void>;
  onVerifyEmailOtp: () => void;
  passkeyUnavailableReason: string | null;
}) {
  const [email, setEmail] = useState("");

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setEmail("");
          onClose();
        }
      }}
    >
      <DialogContent className="border-border/40 bg-background/95 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Wallet className="h-4.5 w-4.5" />
            </div>
            Connect Circle Wallet
          </DialogTitle>
          <DialogDescription>
            Sign in with Circle using Google or email OTP.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="rounded-2xl border border-border/40 bg-card/40 p-4">
            <div className="mb-3 flex items-center gap-2">
              <LogIn className="h-4 w-4 text-primary" />
              <p className="text-sm font-semibold">Google social login</p>
            </div>
            <p className="text-sm text-muted-foreground/70">
              Use the Circle-configured Google OAuth flow to restore the same user wallet.
            </p>
            <Button
              className="mt-4 w-full"
              disabled={!canUseGoogle || isAuthenticating || !isDeviceReady}
              onClick={() => {
                void onRequestGoogleLogin();
              }}
            >
              Continue with Google
            </Button>
            {!canUseGoogle ? (
              <p className="mt-2 text-xs text-muted-foreground/60">
                Add NEXT_PUBLIC_GOOGLE_CLIENT_ID to enable Google sign-in.
              </p>
            ) : !isDeviceReady ? (
              <p className="mt-2 text-xs text-muted-foreground/60">
                Circle device is initializing. Login buttons will enable automatically.
              </p>
            ) : null}
          </div>

          <OTPModal
            email={email}
            setEmail={setEmail}
            isAuthenticating={isAuthenticating}
            isDeviceReady={isDeviceReady}
            hasPendingEmailOtp={hasPendingEmailOtp}
            onRequestEmailOtp={onRequestEmailOtp}
            onVerifyEmailOtp={onVerifyEmailOtp}
          />

          <div className="rounded-2xl border border-border/40 bg-primary/5 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold">Circle manages the wallet session</p>
                <p className="text-sm text-muted-foreground/70">
                  Sign-in creates or restores your Circle user wallet on Arc Testnet and Ethereum Sepolia.
                </p>
              </div>
            </div>
          </div>

          <ErrorState authStatus={authStatus} authError={authError} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
