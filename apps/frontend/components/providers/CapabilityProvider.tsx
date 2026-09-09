"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ArcCapabilities, ArcCapabilityName } from "@wizpay/arc-network";
import {
  CAPABILITY_UNAVAILABLE_MESSAGE,
  fetchEffectiveCapabilities,
} from "@/lib/capabilities";

type CapabilityContextValue = Readonly<{
  capabilities: ArcCapabilities | null;
  failed: boolean;
  loading: boolean;
}>;

const CapabilityContext = createContext<CapabilityContextValue>({
  capabilities: null,
  failed: false,
  loading: true,
});

export function CapabilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [capabilities, setCapabilities] = useState<ArcCapabilities | null>(
    null,
  );
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchEffectiveCapabilities()
      .then((response) => {
        if (!controller.signal.aborted) setCapabilities(response.capabilities);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCapabilities(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSettled(true);
      });
    return () => controller.abort();
  }, []);
  const value = useMemo(
    () => ({
      capabilities,
      failed: settled && !capabilities,
      loading: !settled,
    }),
    [capabilities, settled],
  );
  return (
    <CapabilityContext.Provider value={value}>
      {children}
    </CapabilityContext.Provider>
  );
}

export function useCapability(name: ArcCapabilityName) {
  const state = useContext(CapabilityContext);
  const enabled = state.capabilities?.[name] === true;
  return {
    ...state,
    enabled,
    unavailableMessage: enabled ? null : CAPABILITY_UNAVAILABLE_MESSAGE,
    assertEnabled() {
      if (!enabled) throw new Error(CAPABILITY_UNAVAILABLE_MESSAGE);
    },
  };
}
