export interface ProfilePreferences {
  customIdentity: string;
  xHandle: string;
  updatedAt: number | null;
}

export interface MobileInstallPromptState {
  dismissedAt: number | null;
}

export const PROFILE_PREFERENCES_UPDATED_EVENT =
  "wizpay:profile:preferences-updated";

const PROFILE_PREFERENCES_STORAGE_KEY = "wizpay:profile:preferences";
const MOBILE_INSTALL_PROMPT_STORAGE_KEY = "wizpay:profile:install-prompt";

const EMPTY_PROFILE_PREFERENCES: ProfilePreferences = {
  customIdentity: "",
  xHandle: "",
  updatedAt: null,
};

const EMPTY_INSTALL_PROMPT_STATE: MobileInstallPromptState = {
  dismissedAt: null,
};

type ProfilePreferencesMap = Record<string, ProfilePreferences>;

function hasWindow() {
  return typeof window !== "undefined";
}

function normalizeCustomIdentity(value: string | undefined) {
  return (value ?? "").trim().slice(0, 40);
}

function normalizeXHandle(value: string | undefined) {
  return (value ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .slice(0, 32);
}

function normalizeProfilePreferences(
  value: Partial<ProfilePreferences> | null | undefined,
): ProfilePreferences {
  return {
    customIdentity: normalizeCustomIdentity(value?.customIdentity),
    xHandle: normalizeXHandle(value?.xHandle),
    updatedAt:
      typeof value?.updatedAt === "number" ? value.updatedAt : value?.updatedAt ?? null,
  };
}

function readAllProfilePreferences(): ProfilePreferencesMap {
  if (!hasWindow()) {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(PROFILE_PREFERENCES_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return Object.entries(parsed as Record<string, ProfilePreferences>).reduce<ProfilePreferencesMap>(
      (accumulator, [scopeId, preferences]) => {
        accumulator[scopeId] = normalizeProfilePreferences(preferences);
        return accumulator;
      },
      {},
    );
  } catch {
    return {};
  }
}

function emitProfilePreferencesUpdated(scopeId: string) {
  if (!hasWindow()) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(PROFILE_PREFERENCES_UPDATED_EVENT, {
      detail: { scopeId },
    }),
  );
}

export function readProfilePreferences(scopeId: string): ProfilePreferences {
  if (!scopeId) {
    return EMPTY_PROFILE_PREFERENCES;
  }

  return readAllProfilePreferences()[scopeId] ?? EMPTY_PROFILE_PREFERENCES;
}

export function writeProfilePreferences(
  scopeId: string,
  nextPreferences: Partial<ProfilePreferences>,
) {
  if (!scopeId || !hasWindow()) {
    return EMPTY_PROFILE_PREFERENCES;
  }

  const currentPreferences = readAllProfilePreferences();
  const nextValue: ProfilePreferences = {
    ...normalizeProfilePreferences(currentPreferences[scopeId]),
    ...normalizeProfilePreferences(nextPreferences),
    updatedAt: Date.now(),
  };

  currentPreferences[scopeId] = nextValue;
  window.localStorage.setItem(
    PROFILE_PREFERENCES_STORAGE_KEY,
    JSON.stringify(currentPreferences),
  );
  emitProfilePreferencesUpdated(scopeId);

  return nextValue;
}

export function readMobileInstallPromptState(): MobileInstallPromptState {
  if (!hasWindow()) {
    return EMPTY_INSTALL_PROMPT_STATE;
  }

  try {
    const rawValue = window.localStorage.getItem(MOBILE_INSTALL_PROMPT_STORAGE_KEY);
    if (!rawValue) {
      return EMPTY_INSTALL_PROMPT_STATE;
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return EMPTY_INSTALL_PROMPT_STATE;
    }

    return {
      dismissedAt:
        typeof (parsed as MobileInstallPromptState).dismissedAt === "number"
          ? (parsed as MobileInstallPromptState).dismissedAt
          : null,
    };
  } catch {
    return EMPTY_INSTALL_PROMPT_STATE;
  }
}

export function dismissMobileInstallPrompt(timestampMs = Date.now()) {
  if (!hasWindow()) {
    return EMPTY_INSTALL_PROMPT_STATE;
  }

  const nextValue = { dismissedAt: timestampMs };
  window.localStorage.setItem(
    MOBILE_INSTALL_PROMPT_STORAGE_KEY,
    JSON.stringify(nextValue),
  );

  return nextValue;
}

export function clearMobileInstallPromptState() {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.removeItem(MOBILE_INSTALL_PROMPT_STORAGE_KEY);
}