"use client";

import Image from "next/image";
import {
  Copy,
  Check,
  QrCode,
  Download,
  Share2,
  Wallet,
} from "lucide-react";
import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useToast } from "@/hooks/use-toast";

interface ReceiveQrModalProps {
  open: boolean;
  onClose: () => void;
}

export function ReceiveQrModal({ open, onClose }: ReceiveQrModalProps) {
  const { isConnected, walletAddress } = useActiveWalletAddress();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(async () => {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      toast({ title: "Address copied" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied – silent fallback
    }
  }, [walletAddress, toast]);

  const downloadQr = useCallback(() => {
    if (!walletAddress) return;

    // Use the external API to get a larger QR image for download
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(walletAddress)}&bgcolor=1a1130&color=ffffff&format=png`;

    // Create a temporary anchor to trigger download
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `wizpay-qr-${walletAddress.slice(0, 8)}.png`;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    toast({ title: "Downloading QR code" });
  }, [walletAddress, toast]);

  const shareAddress = useCallback(async () => {
    if (!walletAddress) return;

    // Guard: Web Share API is only available in secure contexts (HTTPS / localhost)
    if (typeof navigator === "undefined" || !navigator.share) return false;

    try {
      await navigator.share({
        title: "WizPay Wallet Address",
        text: `My wallet address: ${walletAddress}`,
        url: undefined,
      });
      return true;
    } catch {
      // User cancelled or share failed – fall back silently
      return false;
    }
  }, [walletAddress]);

  const [canShare] = useState(() => {
    if (typeof navigator === "undefined") return false;
    return typeof navigator.share === "function";
  });

  const qrUrl = walletAddress
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(walletAddress)}&bgcolor=1a1130&color=ffffff`
    : null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="glass-card border-border/40 max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-4 w-4 text-primary" />
            Receive QR
          </DialogTitle>
          <DialogDescription>
            Share your wallet address or let someone scan the QR code.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-4">
          {!isConnected ? (
            /* ── No wallet connected state ── */
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/40 bg-muted/10 px-6 py-10">
              <Wallet className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">
                Connect wallet first
              </p>
              <p className="max-w-[220px] text-center text-xs text-muted-foreground/60">
                Connect your wallet to generate a QR code for your address.
              </p>
            </div>
          ) : (
            <>
              {/* ── QR Code display ── */}
              {qrUrl ? (
                <div className="rounded-2xl border border-border/40 bg-white p-3">
                  <Image
                    src={qrUrl}
                    alt="Wallet QR Code"
                    width={200}
                    height={200}
                    className="rounded-lg"
                    unoptimized
                  />
                </div>
              ) : (
                <div className="h-[200px] w-[200px] rounded-2xl bg-muted/25 animate-pulse" />
              )}

              {/* ── Address display ── */}
              <div className="w-full space-y-3">
                <div className="rounded-xl border border-border/40 bg-background/40 px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
                    Your Address
                  </p>
                  <p className="font-mono text-xs text-foreground/80 break-all">
                    {walletAddress}
                  </p>
                </div>

                {/* ── Action buttons ── */}
                <div className="flex gap-2">
                  <Button
                    onClick={() => void copyAddress()}
                    className="flex-1 gap-2"
                    variant="outline"
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4" />
                        Copy Address
                      </>
                    )}
                  </Button>

                  <Button
                    onClick={downloadQr}
                    className="gap-2"
                    variant="outline"
                    size="icon"
                  >
                    <Download className="h-4 w-4" />
                    <span className="sr-only">Download QR</span>
                  </Button>

                  {canShare && (
                    <Button
                      onClick={() => void shareAddress()}
                      className="gap-2"
                      variant="outline"
                      size="icon"
                    >
                      <Share2 className="h-4 w-4" />
                      <span className="sr-only">Share</span>
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
