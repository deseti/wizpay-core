"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useMediaQuery } from "@/hooks/useMediaQuery";

import {
  clearMobileInstallPromptState,
  dismissMobileInstallPrompt,
  readMobileInstallPromptState,
} from "../storage";

const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MOBILE_UA_REGEX = /android|iphone|ipad|ipod|mobile/i;

type MobilePlatform = "android" | "ios" | "other";

interface InstallChoiceResult {
  outcome: "accepted" | "dismissed";
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoiceResult>;
}

function detectPlatform(userAgent: string): MobilePlatform {
  if (/iphone|ipad|ipod/i.test(userAgent)) {
    return "ios";
  }

  if (/android/i.test(userAgent)) {
    return "android";
  }

  return "other";
}

export function useMobileInstallPrompt() {
  const isMobileViewport = useMediaQuery("(max-width: 767px)");
  const isStandaloneMode = useMediaQuery("(display-mode: standalone)");
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [currentTimestamp, setCurrentTimestamp] = useState(() => Date.now());
  const [platform, setPlatform] = useState<MobilePlatform>("other");
  const [isMobileDevice, setIsMobileDevice] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  const navigatorWithStandalone =
    typeof navigator === "undefined"
      ? null
      : (navigator as Navigator & { standalone?: boolean });
  const isInstalled =
    isStandaloneMode || navigatorWithStandalone?.standalone === true;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const userAgent = navigator.userAgent;
    const syncPromptEnvironment = () => {
      setDismissedAt(readMobileInstallPromptState().dismissedAt);
      setPlatform(detectPlatform(userAgent));
      setIsMobileDevice(MOBILE_UA_REGEX.test(userAgent));
      setCurrentTimestamp(Date.now());
    };

    syncPromptEnvironment();

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      clearMobileInstallPromptState();
      setDismissedAt(null);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
    };

    window.addEventListener(
      "beforeinstallprompt",
      handleBeforeInstallPrompt as EventListener,
    );
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt as EventListener,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const isDismissed = useMemo(() => {
    if (!dismissedAt) {
      return false;
    }

    return currentTimestamp - dismissedAt < DISMISS_TTL_MS;
  }, [currentTimestamp, dismissedAt]);

  const canShowPrompt =
    isMobileViewport && isMobileDevice && !isInstalled && !isDismissed;

  const dismissPrompt = useCallback(() => {
    const nextDismissedAt = Date.now();
    dismissMobileInstallPrompt(nextDismissedAt);
    setDismissedAt(nextDismissedAt);
    setCurrentTimestamp(nextDismissedAt);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) {
      setShowInstructions(true);
      return false;
    }

    await deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    setDeferredPrompt(null);

    if (result.outcome === "accepted") {
      setIsInstalled(true);
      return true;
    }

    setShowInstructions(true);
    return false;
  }, [deferredPrompt]);

  const instructionText =
    platform === "ios"
      ? "Use Safari's Share action, then choose Add to Home Screen to pin WizPay like a native app."
      : platform === "android"
        ? "Open the browser menu and choose Install app or Add to Home screen if the native prompt does not appear."
        : "Use your browser menu to add WizPay to the home screen for a more app-like experience.";

  return {
    canShowPrompt,
    dismissPrompt,
    instructionText,
    isInstalled,
    platform,
    promptInstall,
    setShowInstructions,
    showInstructions,
    supportsNativePrompt: Boolean(deferredPrompt),
  };
}