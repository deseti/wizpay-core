"use client";

import { useEffect } from "react";

import {
  clearPwaDeferredPrompt,
  updatePwaInstallState,
  type BeforeInstallPromptEvent,
  type MobilePlatform,
} from "../install-state";

const MOBILE_UA_REGEX = /android|iphone|ipad|ipod|mobile/i;
const IOS_BROWSER_REGEX = /iphone|ipad|ipod/i;
const IOS_SAFARI_EXCLUSION_REGEX = /crios|fxios|edgios|opios|duckduckgo/i;

function detectPlatform(userAgent: string): MobilePlatform {
  if (IOS_BROWSER_REGEX.test(userAgent)) {
    return "ios";
  }

  if (/android/i.test(userAgent)) {
    return "android";
  }

  return "other";
}

function addMediaQueryListener(
  query: MediaQueryList,
  listener: () => void,
) {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }

  query.addListener(listener);
  return () => query.removeListener(listener);
}

export function PwaRuntime() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const userAgent = window.navigator.userAgent;
    const platform = detectPlatform(userAgent);
    const isMobileDevice = MOBILE_UA_REGEX.test(userAgent);
    const isIosSafari =
      platform === "ios" &&
      /safari/i.test(userAgent) &&
      !IOS_SAFARI_EXCLUSION_REGEX.test(userAgent);
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");

    let cancelled = false;

    const syncInstallState = () => {
      updatePwaInstallState({
        isInstalled:
          standaloneQuery.matches ||
          (window.navigator as Navigator & { standalone?: boolean }).standalone ===
            true,
        isMobileDevice,
        manualInstallAvailable: isIosSafari,
        platform,
      });
    };

    syncInstallState();

    if ("serviceWorker" in window.navigator) {
      void window.navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(() => {
          if (!cancelled) {
            updatePwaInstallState({ isServiceWorkerReady: true });
          }
        })
        .catch((error) => {
          console.warn("[PwaRuntime] Failed to register service worker", error);
        });
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();

      updatePwaInstallState({
        deferredPrompt: promptEvent,
        isInstalled: false,
        isMobileDevice,
        manualInstallAvailable: isIosSafari,
        nativePromptAvailable: true,
        platform,
      });
    };

    const handleAppInstalled = () => {
      clearPwaDeferredPrompt();
      updatePwaInstallState({ isInstalled: true });
    };

    const removeDisplayModeListener = addMediaQueryListener(
      standaloneQuery,
      syncInstallState,
    );

    window.addEventListener(
      "beforeinstallprompt",
      handleBeforeInstallPrompt as EventListener,
    );
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      cancelled = true;
      removeDisplayModeListener();
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt as EventListener,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  return null;
}