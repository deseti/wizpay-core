"use client";

import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import { SwapBridgeWorkspace } from "@/components/dashboard/SwapBridgeWorkspace";

export default function BridgePage() {
  return (
    <DashboardAppFrame>
      <SwapBridgeWorkspace />
    </DashboardAppFrame>
  );
}
