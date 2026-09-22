"use client";

import { usePathname, useRouter } from "next/navigation";
import { BridgeScreen } from "@/components/dashboard/BridgeScreen";
import { SwapScreen } from "@/components/dashboard/SwapScreen";
import { cn } from "@/lib/utils";

export function swapBridgeMode(pathname: string): "swap" | "bridge" {
  return pathname === "/bridge" || pathname.startsWith("/bridge/")
    ? "bridge"
    : "swap";
}

const TABS = [
  { mode: "swap", href: "/swap", label: "Swap" },
  { mode: "bridge", href: "/bridge", label: "Bridge" },
] as const;

/**
 * User-facing Swap and Bridge shell. Each tab renders the existing execution
 * screen unchanged; selecting a tab only changes the route.
 */
export function SwapBridgeWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const mode = swapBridgeMode(pathname);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Swap &amp; Bridge
        </h1>
        <div
          role="tablist"
          aria-label="Swap and Bridge"
          className="inline-flex w-full rounded-2xl border border-border/40 bg-card/60 p-1 sm:w-auto"
        >
          {TABS.map((tab) => {
            const selected = mode === tab.mode;
            return (
              <button
                key={tab.mode}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition-all sm:flex-none",
                  selected
                    ? "bg-primary/15 text-primary shadow-sm"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                )}
                onClick={() => {
                  if (!selected) router.push(tab.href);
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
      {mode === "bridge" ? (
        <BridgeScreen showHeading={false} />
      ) : (
        <SwapScreen />
      )}
    </div>
  );
}
