"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, Coins, Home, User, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/", label: "Home", icon: Home },
  { href: "/swap", label: "Swap", icon: ArrowLeftRight },
  { href: "/liquidity", label: "Liquidity", icon: Coins },
  { href: "/assets", label: "Assets", icon: Wallet },
  { href: "/profile", label: "Profile", icon: User },
] as const;

function isActiveDestination(pathname: string, href: string) {
  if (href === "/") {
    return pathname === "/";
  }

  return (
    pathname === href ||
    pathname.startsWith(`${href}/`)
  );
}

export function DashboardBottomNav() {
  const pathname = usePathname();

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 block md:hidden pb-safe">
      <div className="relative mx-3 mb-3 flex items-center rounded-[1.4rem] border border-border/30 bg-card/70 px-2 py-2.5 backdrop-blur-2xl shadow-[0_-12px_50px_rgba(0,0,0,0.4)]">
        {/* Top glow line */}
        <div className="absolute top-0 left-[18%] right-[18%] h-px bg-gradient-to-r from-transparent via-primary/25 to-transparent" />

        {tabs.map(({ href, label, icon: Icon }) => {
          const isActive = isActiveDestination(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className="group flex min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-1.5 px-1 py-0.5 transition-all active:scale-95"
            >
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-2xl transition-all duration-300",
                  isActive
                    ? "bg-primary/18 text-primary shadow-lg shadow-primary/15"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "transition-all duration-300",
                    isActive
                      ? "h-[18px] w-[18px] icon-glow"
                      : "h-5 w-5 group-hover:scale-110"
                  )}
                />
              </div>
              <span
                className={cn(
                  "max-w-full truncate px-1 text-[11px] font-semibold leading-none transition-all duration-300",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground/70"
                )}
              >
                {label}
              </span>

              {/* Active dot indicator */}
              {isActive && (
                <div className="h-1 w-1 rounded-full bg-primary shadow-sm shadow-primary/50" />
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
