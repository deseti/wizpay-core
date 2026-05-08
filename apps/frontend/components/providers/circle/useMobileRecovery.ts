"use client";

import { useCallback, useEffect, useRef } from "react";
import type React from "react";

import {
  getErrorMessage,
  isCircleExpiredSessionError,
  isPasskeySession,
  type CircleSession,
  type W3SSdkInstance,
} from "@/services/circle-auth.service";

const SESSION_FRESHNESS_MS = 90_000;
const RESUME_FORCE_REINIT_MS = 30_000;
const RESUME_THRESHOLD_MS = 1_500;

function isMobileRecoveryEnvironment() {
  if (typeof window === "undefined") {
    return false;
  }

  const userAgent = window.navigator.userAgent;
  const isMobileDevice = /android|iphone|ipad|ipod|mobile/i.test(userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

  return isMobileDevice || isStandalone;
}

export interface CircleMobileRecoveryDeps {
  session: CircleSession | null;
  ready: boolean;
  authRequestInFlightRef: React.MutableRefObject<boolean>;
  ensureDeviceId: () => Promise<string>;
  handleAuthFailure: (error: unknown) => void;
  loadWalletsEnsuringSolana: (authSession: CircleSession) => Promise<unknown>;
  rearmSdkForSession: (
    authSession: CircleSession,
    options?: { forceReinitialize?: boolean },
  ) => Promise<W3SSdkInstance | null>;
  resetActiveCircleSession: (message: string) => void;
  setAuthError: (value: string | null) => void;
  setAuthStatus: (value: string | null) => void;
}

export function useCircleMobileRecovery({
  session,
  ready,
  authRequestInFlightRef,
  ensureDeviceId,
  handleAuthFailure,
  loadWalletsEnsuringSolana,
  rearmSdkForSession,
  resetActiveCircleSession,
  setAuthError,
  setAuthStatus,
}: CircleMobileRecoveryDeps) {
  const hiddenAtRef = useRef<number | null>(null);
  const needsRecoveryRef = useRef(false);
  const recoveryInFlightRef = useRef<Promise<void> | null>(null);
  const lastSuccessfulCheckAtRef = useRef(0);

  const ensureCircleSessionReady = useCallback(
    async (options?: {
      forceReinitialize?: boolean;
      reason?: string;
      refreshWallets?: boolean;
    }) => {
      const activeSession = session;

      if (
        !activeSession ||
        isPasskeySession(activeSession) ||
        authRequestInFlightRef.current ||
        !isMobileRecoveryEnvironment()
      ) {
        return;
      }

      const now = Date.now();
      const isStale = now - lastSuccessfulCheckAtRef.current > SESSION_FRESHNESS_MS;
      const shouldRefreshWallets =
        Boolean(options?.refreshWallets) ||
        needsRecoveryRef.current ||
        isStale ||
        !ready;

      if (!options?.forceReinitialize && !shouldRefreshWallets) {
        return;
      }

      if (recoveryInFlightRef.current) {
        return recoveryInFlightRef.current;
      }

      const nextRecovery = (async () => {
        setAuthStatus("Restoring Circle wallet session...");

        try {
          await rearmSdkForSession(activeSession, {
            forceReinitialize: options?.forceReinitialize,
          });
          await ensureDeviceId();

          if (shouldRefreshWallets || options?.forceReinitialize) {
            await loadWalletsEnsuringSolana(activeSession);
          }

          needsRecoveryRef.current = false;
          lastSuccessfulCheckAtRef.current = Date.now();
          setAuthError(null);
          setAuthStatus(null);
        } catch (error) {
          if (isCircleExpiredSessionError(error)) {
            const message =
              getErrorMessage(error) ||
              "Your Circle session expired. Sign in again to continue.";
            resetActiveCircleSession(message);
            throw new Error(message);
          }

          setAuthStatus(null);
          handleAuthFailure(error);
          throw error;
        }
      })();

      recoveryInFlightRef.current = nextRecovery;

      try {
        await nextRecovery;
      } finally {
        if (recoveryInFlightRef.current === nextRecovery) {
          recoveryInFlightRef.current = null;
        }
      }
    },
    [
      authRequestInFlightRef,
      ensureDeviceId,
      handleAuthFailure,
      loadWalletsEnsuringSolana,
      ready,
      rearmSdkForSession,
      resetActiveCircleSession,
      session,
      setAuthError,
      setAuthStatus,
    ],
  );

  useEffect(() => {
    if (!session || isPasskeySession(session) || !isMobileRecoveryEnvironment()) {
      return;
    }

    const triggerRecovery = (reason: string, forceReinitialize = false) => {
      needsRecoveryRef.current = true;
      void ensureCircleSessionReady({
        forceReinitialize,
        reason,
        refreshWallets: true,
      });
    };

    const handleFocus = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      const isStale =
        Date.now() - lastSuccessfulCheckAtRef.current > SESSION_FRESHNESS_MS;

      if (needsRecoveryRef.current || isStale) {
        triggerRecovery("focus", false);
      }
    };

    const handleOnline = () => {
      triggerRecovery("online", true);
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        triggerRecovery("pageshow", true);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }

      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;

      if (!hiddenAt) {
        return;
      }

      const hiddenDuration = Date.now() - hiddenAt;

      if (hiddenDuration < RESUME_THRESHOLD_MS) {
        return;
      }

      triggerRecovery(
        "visibilitychange",
        hiddenDuration >= RESUME_FORCE_REINIT_MS,
      );
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [ensureCircleSessionReady, session]);

  return {
    ensureCircleSessionReady,
  };
}