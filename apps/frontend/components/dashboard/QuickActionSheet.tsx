"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { QrCode, ScanLine } from "lucide-react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { ReceiveQrModal } from "@/components/dashboard/ReceiveQrModal";
import { RecipientScannerDialog } from "@/components/dashboard/RecipientScannerDialog";

interface QuickActionSheetProps {
  open: boolean;
  onClose: () => void;
}

export function QuickActionSheet({ open, onClose }: QuickActionSheetProps) {
  const router = useRouter();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  function handleAction(action: () => void) {
    onClose();
    // Small delay so the bottom sheet dismiss animation completes before modal opens
    setTimeout(action, 200);
  }

  const handleScanDetected = useCallback(
    (address: string) => {
      router.push(`/send?recipient=${encodeURIComponent(address)}`);
    },
    [router]
  );

  return (
    <>
      <BottomSheet open={open} onClose={onClose}>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => handleAction(() => setReceiveOpen(true))}
            className="flex flex-col items-center gap-3 rounded-2xl border border-border/40 bg-background/40 p-5 transition-all active:scale-95 hover:border-primary/30 hover:bg-primary/8"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-lg shadow-primary/10">
              <QrCode className="h-6 w-6" />
            </div>
            <span className="text-sm font-semibold text-foreground">
              Receive QR
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              Show your wallet address
            </span>
          </button>

          <button
            onClick={() => handleAction(() => setScanOpen(true))}
            className="flex flex-col items-center gap-3 rounded-2xl border border-border/40 bg-background/40 p-5 transition-all active:scale-95 hover:border-primary/30 hover:bg-primary/8"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-lg shadow-primary/10">
              <ScanLine className="h-6 w-6" />
            </div>
            <span className="text-sm font-semibold text-foreground">
              Scan QR
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              Scan a wallet address
            </span>
          </button>
        </div>
      </BottomSheet>

      <ReceiveQrModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
      <RecipientScannerDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        onDetected={handleScanDetected}
      />
    </>
  );
}
