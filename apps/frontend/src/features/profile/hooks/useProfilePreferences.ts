"use client";

import { useCallback, useEffect, useState } from "react";

import {
  PROFILE_PREFERENCES_UPDATED_EVENT,
  readProfilePreferences,
  writeProfilePreferences,
  type ProfilePreferences,
} from "../storage";

const EMPTY_PROFILE_PREFERENCES: ProfilePreferences = {
  customIdentity: "",
  xHandle: "",
  updatedAt: null,
};

export function useProfilePreferences(scopeId?: string) {
  const [preferences, setPreferences] = useState<ProfilePreferences>(
    EMPTY_PROFILE_PREFERENCES,
  );

  useEffect(() => {
    const syncPreferences = () => {
      setPreferences(
        scopeId ? readProfilePreferences(scopeId) : EMPTY_PROFILE_PREFERENCES,
      );
    };

    syncPreferences();

    if (typeof window === "undefined") {
      return;
    }

    window.addEventListener(
      PROFILE_PREFERENCES_UPDATED_EVENT,
      syncPreferences as EventListener,
    );
    window.addEventListener("storage", syncPreferences);

    return () => {
      window.removeEventListener(
        PROFILE_PREFERENCES_UPDATED_EVENT,
        syncPreferences as EventListener,
      );
      window.removeEventListener("storage", syncPreferences);
    };
  }, [scopeId]);

  const savePreferences = useCallback(
    (nextPreferences: Partial<ProfilePreferences>) => {
      if (!scopeId) {
        return EMPTY_PROFILE_PREFERENCES;
      }

      const savedPreferences = writeProfilePreferences(scopeId, nextPreferences);
      setPreferences(savedPreferences);
      return savedPreferences;
    },
    [scopeId],
  );

  return {
    preferences,
    savePreferences,
  };
}