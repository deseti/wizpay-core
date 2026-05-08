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

type WindowWithIdleCallback = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (callback: () => void) => number;
};

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
    let idleCallbackHandle: number | null = null;

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

    const registerServiceWorker = () => {
      if (!("serviceWorker" in window.navigator)) {
        return;
      }

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
    };

    const scheduleServiceWorkerRegistration = () => {
      const windowWithIdle = window as WindowWithIdleCallback;

      if (typeof windowWithIdle.requestIdleCallback === "function") {
        idleCallbackHandle =
          windowWithIdle.requestIdleCallback(registerServiceWorker);
        return;
      }

      queueMicrotask(registerServiceWorker);
    };

    if (document.readyState === "complete") {
      scheduleServiceWorkerRegistration();
    } else {
      window.addEventListener("load", scheduleServiceWorkerRegistration, {
        once: true,
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
      window.removeEventListener("load", scheduleServiceWorkerRegistration);
      if (idleCallbackHandle !== null) {
        (window as WindowWithIdleCallback).cancelIdleCallback?.(
          idleCallbackHandle,
        );
      }
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
