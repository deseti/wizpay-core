"use client";

import { useCallback } from "react";
import {
  CIRCLE_APP_ID,
  type W3SSdkInstance,
  type StoredLoginConfig,
} from "@/services/circle-auth.service";

export interface EmailAuthDeps {
  authRequestInFlightRef: React.MutableRefObject<boolean>;
  sdkRef: React.RefObject<W3SSdkInstance | null>;
  setAuthError: (msg: string | null) => void;
  setAuthStatus: (msg: string | null) => void;
  setIsAuthenticating: (v: boolean) => void;
  hasPendingEmailOtp: boolean;
  handleAuthFailure: (error: unknown) => void;
  ensureDeviceId: () => Promise<string>;
  postW3sAction: (
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  storeLoginConfig: (value: StoredLoginConfig) => void;
}

export function useEmailAuth({
  authRequestInFlightRef,
  sdkRef,
  setAuthError,
  setAuthStatus,
  setIsAuthenticating,
  hasPendingEmailOtp,
  handleAuthFailure,
  ensureDeviceId,
  postW3sAction,
  storeLoginConfig,
}: EmailAuthDeps) {
  const requestEmailOtp = useCallback(
    async (email: string) => {
      if (!CIRCLE_APP_ID) {
        setAuthError(
          "NEXT_PUBLIC_CIRCLE_APP_ID is missing. Configure Circle Wallets before signing in.",
        );
        return;
      }

      const normalizedEmail = email.trim();

      if (!normalizedEmail) {
        setAuthError("Enter your email address first.");
        return;
      }

      const sdk = sdkRef.current;

      if (!sdk) {
        setAuthError("Circle Web SDK is not ready yet.");
        return;
      }

      if (authRequestInFlightRef.current) {
        return;
      }

      authRequestInFlightRef.current = true;

      setAuthError(null);
      setAuthStatus("Requesting Circle email OTP...");
      setIsAuthenticating(true);

      try {
        const resolvedDeviceId = await ensureDeviceId();
        const payload = (await postW3sAction("requestEmailOtp", {
          deviceId: resolvedDeviceId,
          email: normalizedEmail,
        })) as {
          deviceEncryptionKey: string;
          deviceToken: string;
          otpToken: string;
        };

        const loginConfigs = {
          deviceToken: payload.deviceToken,
          deviceEncryptionKey: payload.deviceEncryptionKey,
          otpToken: payload.otpToken,
          email: {
            email: normalizedEmail,
          },
        };

        sdk.updateConfigs({
          appSettings: { appId: CIRCLE_APP_ID },
          loginConfigs,
        });

        storeLoginConfig({
          loginMethod: "email",
          loginConfigs,
          email: normalizedEmail,
        });

        setAuthStatus(
          "OTP sent. Open the Circle OTP window to verify your email.",
        );
      } catch (error) {
        handleAuthFailure(error);
      } finally {
        authRequestInFlightRef.current = false;
        setIsAuthenticating(false);
      }
    },
    [
      authRequestInFlightRef,
      ensureDeviceId,
      handleAuthFailure,
      postW3sAction,
      sdkRef,
      setAuthError,
      setAuthStatus,
      setIsAuthenticating,
      storeLoginConfig,
    ],
  );

  const verifyEmailOtp = useCallback(() => {
    const sdk = sdkRef.current;

    if (!sdk) {
      setAuthError("Circle Web SDK is not ready yet.");
      return;
    }

    if (!hasPendingEmailOtp) {
      setAuthError("Request an email OTP before verifying it.");
      return;
    }

    setAuthError(null);
    setAuthStatus("Opening Circle email verification window...");
    setIsAuthenticating(true);
    sdk.verifyOtp();
  }, [hasPendingEmailOtp, sdkRef, setAuthError, setAuthStatus, setIsAuthenticating]);

  return { requestEmailOtp, verifyEmailOtp };
}
