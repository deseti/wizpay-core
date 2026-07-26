"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  getAppWalletSwapOperation,
  type AppWalletSwapOperationResponse,
} from "@/lib/app-wallet-swap-service";

const APP_WALLET_OBSERVATION_INTERVAL_MS = 5_000;

interface ScheduleObservationOptions {
  operationId: string;
  onObserved: (operation: AppWalletSwapOperationResponse) => void;
  onObservationError: () => void;
}

export function useAppWalletSwapPoller() {
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleObservation = useCallback(
    ({
      operationId,
      onObserved,
      onObservationError,
    }: ScheduleObservationOptions) => {
      pollTimerRef.current = setTimeout(async () => {
        try {
          const operation = await getAppWalletSwapOperation(operationId);
          onObserved(operation);
        } catch {
          pollTimerRef.current = setTimeout(
            onObservationError,
            APP_WALLET_OBSERVATION_INTERVAL_MS,
          );
        }
      }, APP_WALLET_OBSERVATION_INTERVAL_MS);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  return { scheduleObservation };
}
