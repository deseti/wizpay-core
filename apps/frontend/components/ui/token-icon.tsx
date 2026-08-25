"use client";

import { useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { getTokenVisual } from "@/lib/token-visuals";

export function TokenIcon({ chainId, address, symbol = "?", size = 28, decorative = true, className }: { chainId: number; address: string; symbol?: string; size?: number; decorative?: boolean; className?: string }) {
  const visual = getTokenVisual(chainId, address);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const imageFailed = Boolean(visual && failedSource === visual.iconPath);
  const initials = (visual?.symbol ?? symbol).slice(0, 4).toUpperCase();
  const showImage = Boolean(visual && !imageFailed);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full text-[9px] font-bold",
        showImage ? "bg-transparent" : "bg-muted text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
      aria-label={decorative ? undefined : `${visual?.displayName ?? initials} token`}
      role={decorative ? undefined : "img"}
      data-token-icon={visual?.symbol ?? "unknown"}
      data-token-icon-size={size}
    >
      {visual && !imageFailed ? (
        <Image
          unoptimized
          src={visual.iconPath}
          width={size}
          height={size}
          alt=""
          aria-hidden="true"
          className="block max-w-none"
          style={{
            width: size,
            height: size,
            objectFit: "contain",
            opacity: 1,
            filter: "none",
          }}
          onError={() => setFailedSource(visual.iconPath)}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}
