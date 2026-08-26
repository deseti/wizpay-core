"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";
import { Skeleton } from "@/components/ui/skeleton";

export function InvoiceQrCode({
  value,
  size = 220,
}: {
  value: string;
  size?: number;
}) {
  const [result, setResult] = useState<{
    value: string;
    dataUrl: string | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(value, {
      width: size,
      margin: 2,
      color: { dark: "#17121f", light: "#ffffff" },
      errorCorrectionLevel: "M",
    })
      .then((dataUrl) => {
        if (active) setResult({ value, dataUrl, error: false });
      })
      .catch(() => {
        if (active) setResult({ value, dataUrl: null, error: true });
      });
    return () => {
      active = false;
    };
  }, [size, value]);

  if (result?.value === value && result.error)
    return (
      <div className="flex aspect-square items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/5 p-4 text-center text-sm text-red-300">
        QR code unavailable. Copy the payment link instead.
      </div>
    );
  if (result?.value !== value || !result.dataUrl)
    return (
      <Skeleton
        className="aspect-square rounded-2xl"
        style={{ width: size, maxWidth: "100%" }}
      />
    );
  return (
    <Image
      unoptimized
      src={result.dataUrl}
      width={size}
      height={size}
      alt="QR code for this WizPay checkout URL"
      className="h-auto max-w-full rounded-2xl bg-white p-2"
    />
  );
}
