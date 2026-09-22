import Image from "next/image";
import type { BridgeChainCode } from "@wizpay/bridge-registry";

import { cn } from "@/lib/utils";

const BRIDGE_CHAIN_PRESENTATION: Record<
  BridgeChainCode,
  { label: string; iconPath: string }
> = {
  "ARC-MAINNET": { label: "Arc", iconPath: "/networks/arc.svg" },
  "ETH-MAINNET": { label: "Ethereum", iconPath: "/networks/ethereum.svg" },
  "BASE-MAINNET": { label: "Base", iconPath: "/networks/base.svg" },
  "ARB-MAINNET": { label: "Arbitrum", iconPath: "/networks/arbitrum.svg" },
  "OP-MAINNET": { label: "Optimism", iconPath: "/networks/optimism.svg" },
  "POLYGON-MAINNET": { label: "Polygon", iconPath: "/networks/polygon.svg" },
  "AVAX-MAINNET": { label: "Avalanche", iconPath: "/networks/avalanche.svg" },
};

export function bridgeChainPresentation(code: string) {
  const presentation = BRIDGE_CHAIN_PRESENTATION[code as BridgeChainCode];
  if (!presentation) {
    throw new Error(`Unsupported bridge chain presentation: ${code}.`);
  }
  return presentation;
}

export function BridgeChainIcon({
  chainCode,
  className,
}: {
  chainCode: string;
  className?: string;
}) {
  const { iconPath } = bridgeChainPresentation(chainCode);

  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/95 p-0.5",
        className,
      )}
      aria-hidden="true"
    >
      <Image
        unoptimized
        src={iconPath}
        width={18}
        height={18}
        alt=""
        aria-hidden="true"
        className="h-full w-full object-contain"
      />
    </span>
  );
}

export function BridgeChainLabel({ chainCode }: { chainCode: string }) {
  const { label } = bridgeChainPresentation(chainCode);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <BridgeChainIcon chainCode={chainCode} />
      <span className="truncate">{label}</span>
    </span>
  );
}
