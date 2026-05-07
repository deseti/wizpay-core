"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { AtSign, Search, ShieldCheck, WalletCards } from "lucide-react"

import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const ANS_ROUTE_ITEMS = [
  { href: "/ans", label: "Overview", icon: AtSign },
  { href: "/ans/search", label: "Search", icon: Search },
  { href: "/ans/register", label: "Register", icon: ShieldCheck },
  { href: "/ans/my-domains", label: "My Domains", icon: WalletCards },
] as const

function isRouteActive(pathname: string, href: string) {
  if (href === "/ans") {
    return pathname === href
  }

  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AnsRouteShell({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  const pathname = usePathname()

  return (
    <DashboardAppFrame>
      <div className="space-y-6 animate-fade-up">
        <section className="relative overflow-hidden rounded-3xl border border-border/40 bg-card/40 p-6 shadow-2xl shadow-black/10 backdrop-blur-2xl sm:p-8">
          <div className="pointer-events-none absolute -left-12 top-0 h-40 w-40 rounded-full bg-primary/10 blur-[80px]" />
          <div className="pointer-events-none absolute bottom-0 right-0 h-40 w-40 rounded-full bg-cyan-500/8 blur-[90px]" />

          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
                  ANS v1
                </Badge>
                <Badge variant="outline" className="border-cyan-500/25 bg-cyan-500/10 text-cyan-300">
                  Direct RPC Reads
                </Badge>
                <Badge variant="outline" className="border-amber-500/25 bg-amber-500/10 text-amber-300">
                  No Indexer Yet
                </Badge>
              </div>

              <div>
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground/75 sm:text-base">
                  {description}
                </p>
              </div>
            </div>

            <div className="grid w-full gap-2 sm:grid-cols-2 lg:w-auto lg:min-w-[20rem]">
              {ANS_ROUTE_ITEMS.map(({ href, icon: Icon, label }) => (
                <Button
                  key={href}
                  asChild
                  variant={isRouteActive(pathname, href) ? "default" : "outline"}
                  className={cn(
                    "justify-start gap-2",
                    !isRouteActive(pathname, href) &&
                      "border-border/40 bg-background/35 hover:bg-background/55"
                  )}
                >
                  <Link href={href}>
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                </Button>
              ))}
            </div>
          </div>
        </section>

        {children}
      </div>
    </DashboardAppFrame>
  )
}