"use client";

import { useCallback, useMemo, useState } from "react";

import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  showPwaInstallPrompt,
  usePwaInstallState,
} from "@/src/features/pwa/install-state";

import {
  dismissMobileInstallPrompt,
  readMobileInstallPromptState,
} from "../storage";

const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function useMobileInstallPrompt() {
  const isMobileViewport = useMediaQuery("(max-width: 767px)");
  const {
    isInstalled,
    isMobileDevice,
    manualInstallAvailable,
    nativePromptAvailable,
    platform,
  } = usePwaInstallState();
  const [dismissedAt, setDismissedAt] = useState<number | null>(
    () => readMobileInstallPromptState().dismissedAt,
  );
  const [currentTimestamp, setCurrentTimestamp] = useState(() => Date.now());
  const [showInstructions, setShowInstructions] = useState(false);

  const isDismissed = useMemo(() => {
    if (!dismissedAt) {
      return false;
    }

    return currentTimestamp - dismissedAt < DISMISS_TTL_MS;
  }, [currentTimestamp, dismissedAt]);

  const canShowPrompt =
    isMobileViewport &&
    isMobileDevice &&
    !isInstalled &&
    !isDismissed &&
    (nativePromptAvailable || manualInstallAvailable);

  const dismissPrompt = useCallback(() => {
    const nextDismissedAt = Date.now();
    dismissMobileInstallPrompt(nextDismissedAt);
    setDismissedAt(nextDismissedAt);
    setCurrentTimestamp(nextDismissedAt);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!nativePromptAvailable) {
      setShowInstructions(true);
      return false;
    }

    const result = await showPwaInstallPrompt();

    if (result?.outcome === "accepted") {
      return true;
    }

    setShowInstructions(true);
    return false;
  }, [nativePromptAvailable]);

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
    supportsNativePrompt: nativePromptAvailable,
  };
}