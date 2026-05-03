"use client";

import { useCallback } from "react";
import {
  loginWithPasskey,
  registerWithPasskey,
  readStoredPasskeyCredential,
  readStoredPasskeyUsername,
} from "@/lib/circle-passkey";
import { PASSKEY_CONFIG } from "@/services/circle-auth.service";
import { getPasskeySupportError } from "@/lib/circle-passkey";

export interface PasskeyAuthDeps {
  authRequestInFlightRef: React.MutableRefObject<boolean>;
  setAuthError: (msg: string | null) => void;
  setAuthStatus: (msg: string | null) => void;
  setIsAuthenticating: (v: boolean) => void;
  resetPasskeyRuntimeState: () => void;
  handleAuthFailure: (error: unknown) => void;
  finalizePasskeyAuthentication: (args: {
    credential: NonNullable<ReturnType<typeof readStoredPasskeyCredential>>;
    username: string | null;
  }) => Promise<void>;
}

export function usePasskeyAuth({
  authRequestInFlightRef,
  setAuthError,
  setAuthStatus,
  setIsAuthenticating,
  resetPasskeyRuntimeState,
  handleAuthFailure,
  finalizePasskeyAuthentication,
}: PasskeyAuthDeps) {
  const requestPasskeyRegistration = useCallback(
    async (username: string) => {
      const normalizedUsername = username.trim();
      const supportError = getPasskeySupportError(PASSKEY_CONFIG);

      if (supportError) {
        setAuthError(supportError);
        return;
      }

      if (!normalizedUsername) {
        setAuthError("Enter a username before creating a passkey.");
        return;
      }

      if (authRequestInFlightRef.current) {
        return;
      }

      authRequestInFlightRef.current = true;
      setAuthError(null);
      setAuthStatus("Creating your Circle passkey...");
      setIsAuthenticating(true);

      try {
        resetPasskeyRuntimeState();

        const result = await registerWithPasskey(
          normalizedUsername,
          PASSKEY_CONFIG,
        );

        setAuthStatus("Preparing your Circle passkey wallet...");
        await finalizePasskeyAuthentication({
          credential: result.credential,
          username: normalizedUsername,
        });
      } catch (error) {
        resetPasskeyRuntimeState();
        handleAuthFailure(error);
      } finally {
        authRequestInFlightRef.current = false;
        setIsAuthenticating(false);
      }
    },
    [
      authRequestInFlightRef,
      finalizePasskeyAuthentication,
      handleAuthFailure,
      resetPasskeyRuntimeState,
      setAuthError,
      setAuthStatus,
      setIsAuthenticating,
    ],
  );

  const requestPasskeyLogin = useCallback(async () => {
    const supportError = getPasskeySupportError(PASSKEY_CONFIG);

    if (supportError) {
      setAuthError(supportError);
      return;
    }

    if (authRequestInFlightRef.current) {
      return;
    }

    authRequestInFlightRef.current = true;
    setAuthError(null);
    setAuthStatus("Opening your passkey prompt...");
    setIsAuthenticating(true);

    try {
      resetPasskeyRuntimeState();

      const credential = await loginWithPasskey(PASSKEY_CONFIG);

      setAuthStatus("Restoring your Circle passkey wallet...");
      await finalizePasskeyAuthentication({
        credential,
        username: readStoredPasskeyUsername(),
      });
    } catch (error) {
      resetPasskeyRuntimeState();
      handleAuthFailure(error);
    } finally {
      authRequestInFlightRef.current = false;
      setIsAuthenticating(false);
    }
  }, [
    authRequestInFlightRef,
    finalizePasskeyAuthentication,
    handleAuthFailure,
    resetPasskeyRuntimeState,
    setAuthError,
    setAuthStatus,
    setIsAuthenticating,
  ]);

  return { requestPasskeyLogin, requestPasskeyRegistration };
}
