"use client";

import { useCallback } from "react";
import { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";
import {
  CIRCLE_APP_ID,
  GOOGLE_CLIENT_ID,
  type W3SSdkInstance,
  type GoogleOAuthDiagnostics,
  type StoredLoginConfig,
  buildGoogleLoginConfigs,
  readGoogleLoginConfigFromCookies,
  persistGoogleLoginCookies,
  clearCircleOAuthState,
} from "@/services/circle-auth.service";

export interface GoogleAuthDeps {
  authRequestInFlightRef: React.MutableRefObject<boolean>;
  sdkRef: React.RefObject<W3SSdkInstance | null>;
  googleOAuthDiagnosticsRef: React.MutableRefObject<GoogleOAuthDiagnostics | null>;
  setAuthError: (msg: string | null) => void;
  setAuthStatus: (msg: string | null) => void;
  setIsAuthenticating: (v: boolean) => void;
  handleAuthFailure: (error: unknown) => void;
  ensureDeviceId: () => Promise<string>;
  postW3sAction: (
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  storeLoginConfig: (value: StoredLoginConfig) => void;
  clearStoredLoginConfig: (options?: { preserveGoogleCookies?: boolean }) => void;
}

export function useGoogleAuth({
  authRequestInFlightRef,
  sdkRef,
  googleOAuthDiagnosticsRef,
  setAuthError,
  setAuthStatus,
  setIsAuthenticating,
  handleAuthFailure,
  ensureDeviceId,
  postW3sAction,
  storeLoginConfig,
  clearStoredLoginConfig,
}: GoogleAuthDeps) {
  const requestGoogleLogin = useCallback(async () => {
    if (!CIRCLE_APP_ID) {
      setAuthError(
        "NEXT_PUBLIC_CIRCLE_APP_ID is missing. Configure Circle Wallets before signing in.",
      );
      return;
    }

    if (!GOOGLE_CLIENT_ID) {
      setAuthError(
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID is missing. Add your Circle-linked Google client ID first.",
      );
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
    setAuthStatus("Preparing Google sign-in...");
    setIsAuthenticating(true);

    try {
      googleOAuthDiagnosticsRef.current = null;
      clearCircleOAuthState();
      clearStoredLoginConfig({ preserveGoogleCookies: true });

      const cachedGoogleLoginConfig = readGoogleLoginConfigFromCookies();
      let loginConfigs: Record<string, unknown>;

      if (cachedGoogleLoginConfig) {
        loginConfigs = cachedGoogleLoginConfig.loginConfigs;
        setAuthStatus("Reusing Circle device registration...");
      } else {
        const resolvedDeviceId = await ensureDeviceId();

        setAuthStatus("Creating Circle device token...");

        const payload = (await postW3sAction("createDeviceToken", {
          deviceId: resolvedDeviceId,
        })) as {
          deviceEncryptionKey: string;
          deviceToken: string;
        };

        if (!payload.deviceEncryptionKey || !payload.deviceToken) {
          throw new Error(
            "Circle did not return device credentials. " +
              "Check that CIRCLE_API_KEY is set on the backend.",
          );
        }

        loginConfigs = buildGoogleLoginConfigs({
          deviceEncryptionKey: payload.deviceEncryptionKey,
          deviceToken: payload.deviceToken,
          googleClientId: GOOGLE_CLIENT_ID,
        });

        persistGoogleLoginCookies({
          appId: CIRCLE_APP_ID,
          deviceEncryptionKey: payload.deviceEncryptionKey,
          deviceToken: payload.deviceToken,
          googleClientId: GOOGLE_CLIENT_ID,
        });
      }

      storeLoginConfig({
        loginMethod: "google",
        loginConfigs,
      });

      sdk.updateConfigs({
        appSettings: { appId: CIRCLE_APP_ID },
        loginConfigs,
      });

      setAuthStatus("Redirecting to Google...");

      // Let the SDK handle OAuth URL generation, state/nonce persistence,
      // and the redirect. The SDK's saveOAuthInfo writes 'socialLoginProvider',
      // 'state', and 'nonce' to localStorage, and its checkSocialLoginState
      // reads them back on return. Manual management causes mismatches.
      await sdk.performLogin(SocialLoginProvider.GOOGLE);
    } catch (error) {
      setIsAuthenticating(false);
      handleAuthFailure(error);
    }
  }, [
    authRequestInFlightRef,
    clearStoredLoginConfig,
    ensureDeviceId,
    googleOAuthDiagnosticsRef,
    handleAuthFailure,
    postW3sAction,
    sdkRef,
    setAuthError,
    setAuthStatus,
    setIsAuthenticating,
    storeLoginConfig,
  ]);

  return { requestGoogleLogin };
}
