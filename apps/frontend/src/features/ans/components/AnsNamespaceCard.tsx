"use client"

import { Building2, Clock3, ShieldCheck, Wallet } from "lucide-react"
import type { Address } from "viem"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

import type { AnsNamespaceSnapshot } from "../types/ans"
import { formatPromoWindow, formatUsdcAmount } from "../utils/format"

function formatCompactAddress(address: Address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function AnsNamespaceCard({
  snapshot,
  isLoading = false,
}: {
  snapshot?: AnsNamespaceSnapshot
  isLoading?: boolean
}) {
  if (isLoading || !snapshot) {
    return (
      <Card className="glass-card border-border/40">
        <CardHeader className="space-y-3">
          <div className="h-5 w-32 animate-pulse rounded bg-muted/30" />
          <div className="h-4 w-24 animate-pulse rounded bg-muted/20" />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {[1, 2, 3].map((item) => (
              <div key={item} className="rounded-2xl border border-border/30 bg-background/25 p-3">
                <div className="h-3 w-20 animate-pulse rounded bg-muted/20" />
                <div className="mt-2 h-5 w-24 animate-pulse rounded bg-muted/25" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="glass-card border-border/40">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-xl font-bold tracking-tight">
              {snapshot.suffix}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground/70">
              {snapshot.isGlobal
                ? "Protocol global namespace"
                : "Partner-operated namespace with its own controller and vault"}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className={snapshot.active
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/25 bg-amber-500/10 text-amber-300"}
            >
              {snapshot.active ? "Active" : "Suspended"}
            </Badge>
            {snapshot.isGlobal ? (
              <Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
                Global
              </Badge>
            ) : null}
            {snapshot.blacklisted ? (
              <Badge variant="outline" className="border-red-500/25 bg-red-500/10 text-red-300">
                Blacklisted
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">3 chars</p>
            <p className="mt-2 font-mono text-lg font-semibold">{formatUsdcAmount(snapshot.threeCharacterPrice)}</p>
          </div>
          <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">4 chars</p>
            <p className="mt-2 font-mono text-lg font-semibold">{formatUsdcAmount(snapshot.fourCharacterPrice)}</p>
          </div>
          <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">5+ chars</p>
            <p className="mt-2 font-mono text-lg font-semibold">{formatUsdcAmount(snapshot.fivePlusCharacterPrice)}</p>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Building2 className="h-4 w-4 text-primary" />
              Namespace wiring
            </div>
            <dl className="mt-3 space-y-2 text-sm text-muted-foreground/75">
              <div className="flex items-center justify-between gap-3">
                <dt>Owner</dt>
                <dd className="font-mono text-foreground/85">{formatCompactAddress(snapshot.namespaceOwner)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Registrar</dt>
                <dd className="font-mono text-foreground/85">{formatCompactAddress(snapshot.registrar)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Controller</dt>
                <dd className="font-mono text-foreground/85">{formatCompactAddress(snapshot.controller)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Vault</dt>
                <dd className="font-mono text-foreground/85">{formatCompactAddress(snapshot.vault)}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Clock3 className="h-4 w-4 text-cyan-300" />
              Promo window
            </div>
            <p className="mt-3 text-sm text-muted-foreground/75">
              {snapshot.promoEnabled
                ? `${snapshot.promoDiscountBps / 100}% discount active: ${formatPromoWindow(
                    snapshot.promoStartsAt,
                    snapshot.promoEndsAt
                  )}`
                : "No promo discount is active right now."}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <Badge variant="outline" className="border-border/40 bg-background/30 text-foreground/80">
                <ShieldCheck className="mr-1 h-3 w-3" />
                Whitelisted: {snapshot.whitelisted ? "yes" : "no"}
              </Badge>
              <Badge variant="outline" className="border-border/40 bg-background/30 text-foreground/80">
                <Wallet className="mr-1 h-3 w-3" />
                Default Resolver: {formatCompactAddress(snapshot.defaultResolver)}
              </Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}