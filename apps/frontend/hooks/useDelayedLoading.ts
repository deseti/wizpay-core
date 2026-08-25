"use client";

import { useEffect, useRef, useState } from "react";

export function useDelayedLoading(
  loading: boolean,
  { delayMs = 140, minimumMs = 220 } = {},
) {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (loading) {
      if (!visible) {
        timer = setTimeout(() => {
          shownAt.current = Date.now();
          setVisible(true);
        }, delayMs);
      }
    } else if (visible) {
      const elapsed = shownAt.current ? Date.now() - shownAt.current : minimumMs;
      timer = setTimeout(() => {
        shownAt.current = null;
        setVisible(false);
      }, Math.max(0, minimumMs - elapsed));
    }

    return () => timer && clearTimeout(timer);
  }, [delayMs, loading, minimumMs, visible]);

  return visible;
}
