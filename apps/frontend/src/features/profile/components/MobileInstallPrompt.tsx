"use client";

import {
  ArrowDownToLine,
  Share2,
  Smartphone,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useMobileInstallPrompt } from "../hooks/useMobileInstallPrompt";

export function MobileInstallPrompt({
  hasBottomNav = true,
}: {
  hasBottomNav?: boolean;
}) {
  const {
    canShowPrompt,
    dismissPrompt,
    instructionText,
    platform,
    promptInstall,
    showInstructions,
    supportsNativePrompt,
  } = useMobileInstallPrompt();

  if (!canShowPrompt) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed inset-x-0 z-40 px-3 pb-safe md:hidden",
        hasBottomNav ? "bottom-[5.85rem]" : "bottom-3",
      )}
    >
      <div className="glass-card glow-card overflow-hidden rounded-[1.75rem] border border-primary/20 px-4 py-4 shadow-2xl shadow-black/45">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Smartphone className="h-5 w-5 icon-glow" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                Install WizPay on your phone
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground/75">
                Keep the mobile flow closer to a native wallet app with a home-screen launch,
                full-screen feel, and faster return access.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={dismissPrompt}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-label="Dismiss install prompt"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 rounded-2xl border border-border/35 bg-background/40 p-3">
          <div className="flex items-start gap-2.5">
            <ArrowDownToLine className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground/65">
                {supportsNativePrompt ? "One-tap install" : `Manual ${platform} install`}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground/80">
                {showInstructions || !supportsNativePrompt
                  ? instructionText
                  : "Use the native browser prompt to pin WizPay like an app. If it does not appear, the manual home-screen flow still works."}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            className="glow-btn h-10 flex-1 rounded-2xl bg-gradient-to-r from-primary to-violet-500 text-primary-foreground"
            onClick={() => {
              void promptInstall();
            }}
          >
            <span className="flex items-center gap-1.5">
              <Share2 className="h-4 w-4" />
              {supportsNativePrompt ? "Install app" : "Add to Home Screen"}
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-2xl border-border/40 bg-background/40 px-4"
            onClick={dismissPrompt}
          >
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}