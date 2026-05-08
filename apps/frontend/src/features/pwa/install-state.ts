"use client";

import { useSyncExternalStore } from "react";

export type MobilePlatform = "android" | "ios" | "other";

export interface InstallChoiceResult {
  outcome: "accepted" | "dismissed";
  platform: string;
}

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoiceResult>;
}

export interface PwaInstallState {
  deferredPrompt: BeforeInstallPromptEvent | null;
  isInstalled: boolean;
  isMobileDevice: boolean;
  isServiceWorkerReady: boolean;
  manualInstallAvailable: boolean;
  nativePromptAvailable: boolean;
  platform: MobilePlatform;
}

const listeners = new Set<() => void>();

let state: PwaInstallState = {
  deferredPrompt: null,
  isInstalled: false,
  isMobileDevice: false,
  isServiceWorkerReady: false,
  manualInstallAvailable: false,
  nativePromptAvailable: false,
  platform: "other",
};

function emitChange() {
  listeners.forEach((listener) => listener());
}

export function updatePwaInstallState(partial: Partial<PwaInstallState>) {
  state = {
    ...state,
    ...partial,
  };
  emitChange();
}

export function clearPwaDeferredPrompt() {
  updatePwaInstallState({
    deferredPrompt: null,
    nativePromptAvailable: false,
  });
}

export async function showPwaInstallPrompt() {
  const promptEvent = state.deferredPrompt;

  if (!promptEvent) {
    return null;
  }

  await promptEvent.prompt();
  const result = await promptEvent.userChoice;

  updatePwaInstallState({
    deferredPrompt: null,
    isInstalled: result.outcome === "accepted" ? true : state.isInstalled,
    nativePromptAvailable: false,
  });

  return result;
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

export function usePwaInstallState() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}