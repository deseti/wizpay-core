"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAdaptivePolling } from "@/hooks/useAdaptivePolling";
import {
  getCircleTransferStatus,
  TransferApiError,
  type CircleTransfer,
  type CircleTransferBlockchain,
} from "@/lib/transfer-service";

import {
  BRIDGE_POLL_INTERVAL_MS,
  BRIDGE_STUCK_TIMEOUT_MS,
} from "./bridge-types";
import {
  clearStoredActiveTransfer,
  getStoredActiveTransfer,
  setStoredActiveTransfer,
} from "./bridge-storage";
import {
  getBridgeErrorMessage,
  isTrackedTransfer,
  recoverTerminalTransfer,
} from "./bridge-utils";

interface UseBridgeTransferLifecycleParams {
  transfer: CircleTransfer | null;
  setTransfer: React.Dispatch<React.SetStateAction<CircleTransfer | null>>;
  sourceLabel: string;
  destinationLabel: string;
  setSourceChain: React.Dispatch<React.SetStateAction<CircleTransferBlockchain>>;
  setDestinationChain: React.Dispatch<
    React.SetStateAction<CircleTransferBlockchain>
  >;
  setAmount: React.Dispatch<React.SetStateAction<string>>;
  setDestinationAddress: React.Dispatch<React.SetStateAction<string>>;
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>;
  onTerminalTransferUpdate: (latest: CircleTransfer) => void;
}

export function useBridgeTransferLifecycle({
  transfer,
  setTransfer,
  sourceLabel,
  destinationLabel,
  setSourceChain,
  setDestinationChain,
  setAmount,
  setDestinationAddress,
  setErrorMessage,
  onTerminalTransferUpdate,
}: UseBridgeTransferLifecycleParams) {
  const restoredTransferRef = useRef(false);
  const reconnectingPollCountRef = useRef(0);
  const pollTransferFnRef = useRef<(() => Promise<void>) | null>(null);

  const [isPollingTransfer, setIsPollingTransfer] = useState(false);
  const [isReconnectingToTracking, setIsReconnectingToTracking] =
    useState(false);

  const isTransferActive = isTrackedTransfer(transfer);
  const isExternalBridgeTransfer =
    transfer?.transferId?.startsWith("ext-") ?? false;

  useEffect(() => {
    if (restoredTransferRef.current) return;
    restoredTransferRef.current = true;

    const storedTransfer = getStoredActiveTransfer();
    if (!storedTransfer) return;

    const recoveredTransfer = recoverTerminalTransfer(storedTransfer);
    if (recoveredTransfer) {
      clearStoredActiveTransfer();
      return;
    }

    if (
      storedTransfer.status === "settled" ||
      storedTransfer.status === "failed"
    ) {
      clearStoredActiveTransfer();
      return;
    }

    const storedAgeMs =
      Date.now() - new Date(storedTransfer.createdAt).getTime();
    if (storedAgeMs > BRIDGE_STUCK_TIMEOUT_MS) {
      clearStoredActiveTransfer();
      return;
    }

    if (
      storedTransfer.transferId.startsWith("0x") ||
      storedTransfer.transferId.startsWith("ext-")
    ) {
      clearStoredActiveTransfer();
      return;
    }

    setTransfer(storedTransfer);
    setSourceChain(storedTransfer.sourceBlockchain);
    setDestinationChain(storedTransfer.blockchain);
    setAmount(storedTransfer.amount);
    setDestinationAddress(storedTransfer.destinationAddress || "");
  }, [
    setAmount,
    setDestinationAddress,
    setDestinationChain,
    setSourceChain,
    setTransfer,
  ]);

  useEffect(() => {
    if (!transfer) return;
    setStoredActiveTransfer(transfer);
  }, [transfer]);

  useEffect(() => {
    if (
      !transfer?.transferId ||
      !isTransferActive ||
      isExternalBridgeTransfer
    ) {
      // These flags are deliberately reset whenever polling is not applicable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsPollingTransfer(false);
      setIsReconnectingToTracking(false);
      return;
    }

    const activeTransferId = transfer.transferId;
    let cancelled = false;

    async function pollTransfer() {
      setIsPollingTransfer(true);
      try {
        const latest = await getCircleTransferStatus(activeTransferId);
        if (cancelled) return;

        setTransfer(latest);
        setStoredActiveTransfer(latest);
        reconnectingPollCountRef.current = 0;
        setIsReconnectingToTracking(false);
        setErrorMessage(null);
        onTerminalTransferUpdate(latest);
      } catch (error) {
        if (cancelled) return;

        if (
          error instanceof TransferApiError &&
          error.code === "CIRCLE_BRIDGE_NOT_FOUND"
        ) {
          const recovered = recoverTerminalTransfer(transfer);
          if (recovered) {
            setTransfer(recovered);
            setIsReconnectingToTracking(false);
            setErrorMessage(null);
            onTerminalTransferUpdate(recovered);
            return;
          }

          reconnectingPollCountRef.current += 1;
          if (reconnectingPollCountRef.current >= 15) {
            reconnectingPollCountRef.current = 0;
            clearStoredActiveTransfer();
            setTransfer(null);
            setIsReconnectingToTracking(false);
            setErrorMessage(
              "Bridge tracking timed out. The task no longer exists on backend."
            );
            return;
          }

          setIsReconnectingToTracking(true);
          setErrorMessage(
            "Bridge not yet detected on backend. Reconnecting to status tracking..."
          );
          return;
        }

        setIsReconnectingToTracking(false);
        setErrorMessage(
          getBridgeErrorMessage(error, {
            destinationLabel,
            sourceLabel,
          })
        );
      } finally {
        if (!cancelled) setIsPollingTransfer(false);
      }
    }

    pollTransferFnRef.current = pollTransfer;
    void pollTransfer();

    return () => {
      cancelled = true;
      pollTransferFnRef.current = null;
    };
  }, [
    destinationLabel,
    isExternalBridgeTransfer,
    isTransferActive,
    onTerminalTransferUpdate,
    setErrorMessage,
    setTransfer,
    sourceLabel,
    transfer,
    transfer?.transferId,
  ]);

  useAdaptivePolling({
    onPoll: () => void pollTransferFnRef.current?.(),
    activeInterval: BRIDGE_POLL_INTERVAL_MS,
    idleInterval: 15_000,
    idleAfter: 60_000,
    enabled: Boolean(transfer?.transferId) && isTransferActive,
  });

  const clearTransferTracking = useCallback(() => {
    clearStoredActiveTransfer();
    setTransfer(null);
    setIsPollingTransfer(false);
    setIsReconnectingToTracking(false);
    reconnectingPollCountRef.current = 0;
  }, [setTransfer]);

  const resetTransferTrackingState = useCallback(() => {
    reconnectingPollCountRef.current = 0;
    setIsReconnectingToTracking(false);
  }, []);

  const syncTrackedTransfer = useCallback(
    (nextTransfer: CircleTransfer, fallbackDestinationAddress: string) => {
      setTransfer(nextTransfer);
      setStoredActiveTransfer(nextTransfer);
      setSourceChain(nextTransfer.sourceBlockchain);
      setDestinationChain(nextTransfer.blockchain);
      setAmount(nextTransfer.amount);
      setDestinationAddress(
        nextTransfer.destinationAddress || fallbackDestinationAddress
      );
      reconnectingPollCountRef.current = 0;
      setIsReconnectingToTracking(false);
    },
    [
      setAmount,
      setDestinationAddress,
      setDestinationChain,
      setSourceChain,
      setTransfer,
    ]
  );

  return {
    isPollingTransfer,
    isReconnectingToTracking,
    isExternalBridgeTransfer,
    clearTransferTracking,
    resetTransferTrackingState,
    syncTrackedTransfer,
  };
}