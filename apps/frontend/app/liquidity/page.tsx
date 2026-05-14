"use client";

import { CircleOff } from "lucide-react";

import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";

function LiquidityWorkspace() {
  return (
    <div className="animate-fade-up mx-auto max-w-2xl space-y-5">
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-300">
          <CircleOff className="h-5 w-5" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Legacy liquidity is disabled
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground/80">
          The internal LP vault and SFX-LP deposit or withdrawal flow are not
          available during the official Circle StableFX migration. FX execution
          must use the official StableFX RFQ path once API authentication and
          entitlement are available.
        </p>
      </div>
    </div>
  );
}

export default function LiquidityPage() {
  return (
    <DashboardAppFrame>
      <LiquidityWorkspace />
    </DashboardAppFrame>
  );
}
