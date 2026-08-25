"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ImageUp, Loader2, ScanLine } from "lucide-react";
import { parseEvmPaymentPayload, type EvmPaymentPrefill } from "@/lib/evm-payment-uri";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RecipientScannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetected: (prefill: EvmPaymentPrefill) => void;
}

interface Html5QrcodeLike {
  start: (
    cameraConfig: { facingMode: string },
    config: { fps: number; qrbox: number },
    onSuccess: (decodedText: string) => void,
    onError?: (errorMessage: string) => void
  ) => Promise<unknown>;
  stop: () => Promise<unknown>;
  clear: () => Promise<unknown>;
  scanFile: (file: File, showImage?: boolean) => Promise<string>;
}

export function RecipientScannerDialog({
  open,
  onOpenChange,
  onDetected,
}: RecipientScannerDialogProps) {
  const scannerElementId = useId().replace(/:/g, "-");
  const scannerRef = useRef<Html5QrcodeLike | null>(null);
  const handledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isStartingScanner, setIsStartingScanner] = useState(false);
  const [cameraStarted, setCameraStarted] = useState(false);
  const [isScanningImage, setIsScanningImage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;

    if (!scanner) {
      return;
    }

    scannerRef.current = null;

    try {
      await scanner.stop();
    } catch {
      // Scanner may not be fully started yet.
    }

    try {
      await scanner.clear();
    } catch {
      // The preview area may already be cleared.
    }
  }, []);

  const handleDetectedValue = useCallback(
    async (decodedText: string) => {
      if (handledRef.current) return;
      let prefill: EvmPaymentPrefill;
      try {
        prefill = parseEvmPaymentPayload(decodedText);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unsupported QR payload.");
        return;
      }
      handledRef.current = true;
      await stopScanner();
      setCameraStarted(false);
      onDetected(prefill);
      onOpenChange(false);
    },
    [onDetected, onOpenChange, stopScanner]
  );

  const startScanner = useCallback(async () => {
    handledRef.current = false;
    setErrorMessage(null);
    setIsStartingScanner(true);

    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode(
        scannerElementId
      ) as unknown as Html5QrcodeLike;

      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 220 },
        (decodedText) => {
          void handleDetectedValue(decodedText);
        }
      );
      setCameraStarted(true);
    } catch {
      await stopScanner();
      setCameraStarted(false);
      setErrorMessage(
        "Camera scan is not available right now. Try uploading a QR image instead."
      );
    } finally {
      setIsStartingScanner(false);
    }
  }, [handleDetectedValue, scannerElementId, stopScanner]);

  useEffect(() => () => { void stopScanner(); }, [stopScanner]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      void stopScanner();
      setCameraStarted(false);
      setErrorMessage(null);
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, stopScanner]);

  const handleImageUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];

      if (!file) {
        return;
      }

      setErrorMessage(null);
      setIsScanningImage(true);

      try {
        await stopScanner();

        const { Html5Qrcode } = await import("html5-qrcode");
        const scanner = new Html5Qrcode(
          scannerElementId
        ) as unknown as Html5QrcodeLike;

        scannerRef.current = scanner;

        const decodedText = await scanner.scanFile(file, true);
        await handleDetectedValue(decodedText);
      } catch {
        setErrorMessage("We could not read a wallet address from that image.");
      } finally {
        event.target.value = "";
        setIsScanningImage(false);
      }
    },
    [handleDetectedValue, scannerElementId, stopScanner]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="glass-card max-w-lg border-border/40 bg-background/95">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-4 w-4 text-primary" />
            Scan wallet QR
          </DialogTitle>
          <DialogDescription>
            Point your camera at a wallet QR, or upload a screenshot if the
            camera is not available.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-border/40 bg-background/40">
            <div id={scannerElementId} className="min-h-[260px] w-full" />
          </div>

          {!cameraStarted && !isStartingScanner ? (
            <Button type="button" className="w-full gap-2" onClick={() => void startScanner()}>
              <ScanLine className="h-4 w-4" />
              Start camera
            </Button>
          ) : null}

          {isStartingScanner ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting camera...
            </p>
          ) : null}

          {errorMessage ? (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90">
              {errorMessage}
            </div>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="outline"
              className="gap-2 border-border/40"
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanningImage}
            >
              {isScanningImage ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImageUp className="h-4 w-4" />
              )}
              {isScanningImage ? "Reading image..." : "Upload QR image"}
            </Button>
            <p className="text-xs text-muted-foreground/60">
              Supports plain EVM addresses and validated EIP-681
              <span className="font-mono"> ethereum:</span> payment URIs.
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageUpload}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
