import { useCallback, useEffect } from "react";
import { DEVICE_ID_STORAGE_KEY, removeStoredValue } from "@/services/circle-auth.service";

export function useDeviceToken({
  deviceId,
  setDeviceId,
}: {
  deviceId: string;
  setDeviceId: (id: string) => void;
}) {
  const resetDeviceId = useCallback(() => {
    setDeviceId("");
    removeStoredValue(DEVICE_ID_STORAGE_KEY);
  }, [setDeviceId]);

  return {
    deviceId,
    resetDeviceId,
  };
}
