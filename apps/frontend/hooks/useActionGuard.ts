"use client";

import { useCallback, useRef, useState } from "react";

interface UseActionGuardOptions {
  /** Timeout in ms to re-enable the action (fallback). Set to 0 to disable timeout. */
  timeout?: number;
}

/**
 * Prevents duplicate submissions (double-click protection).
 * Returns isProcessing state + a guard wrapper for async actions.
 *
 * Uses a ref-based lock internally to prevent race conditions from
 * rapid clicks, independent of React's async state updates.
 */
export function useActionGuard(options: UseActionGuardOptions = {}) {
  const { timeout = 0 } = options;
  const [isProcessing, setIsProcessing] = useState(false);
  const lockRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const guard = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | null> => {
      // Use ref-based lock to prevent race conditions from rapid clicks.
      // React state updates are async, so checking state alone is insufficient.
      if (lockRef.current) return null;

      lockRef.current = true;
      setIsProcessing(true);

      if (timerRef.current) clearTimeout(timerRef.current);
      if (timeout > 0) {
        timerRef.current = setTimeout(() => {
          lockRef.current = false;
          setIsProcessing(false);
        }, timeout);
      }

      try {
        const result = await action();
        return result;
      } finally {
        lockRef.current = false;
        setIsProcessing(false);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }
    },
    [timeout]
  );

  const reset = useCallback(() => {
    lockRef.current = false;
    setIsProcessing(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return { isProcessing, guard, reset };
}
