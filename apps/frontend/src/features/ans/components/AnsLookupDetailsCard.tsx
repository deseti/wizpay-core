"use client"

import { AlertTriangle, Globe2, SearchCheck, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyStateView } from "@/components/ui/empty-state"

import type { AnsDomainLookup, ParsedAnsSearchInput } from "../types/ans"
import {
  formatDomainStatus,
  formatRelativeYears,
  formatTimestamp,
  formatUsdcAmount,
} from "../utils/format"

function formatAddress(value: string | null) {
  if (!value) {
    return "Not set"
  }

  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

export function AnsLookupDetailsCard({
  parsedSearch,
  lookup,
  isLoading,
  errorMessage,
}: {
  parsedSearch: ParsedAnsSearchInput
  lookup: AnsDomainLookup | null | undefined
  isLoading: boolean
  errorMessage?: string | null
}) {
  if (!parsedSearch.target && !parsedSearch.error && !isLoading) {
    return (
      <EmptyStateView
        icon={<SearchCheck className="h-7 w-7 text-primary/70" />}
        title="Search an exact ANS name"
        description="Exact-match reads come directly from the current Arc testnet contracts. Ownership, resolver records, expiry, and pricing all come from live on-chain reads."
      />
    )
  }

  if (parsedSearch.error) {
    return (
      <Card className="border-red-500/25 bg-red-500/5">
        <CardContent className="flex items-start gap-3 py-5">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-red-300" />
          <div>
            <p className="font-medium text-red-200">Search input is not valid.</p>
            <p className="mt-1 text-sm text-red-200/80">{parsedSearch.error}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) {
    return (
      <Card className="glass-card border-border/40">
        <CardHeader>
          <div className="h-6 w-48 animate-pulse rounded bg-muted/25" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-16 animate-pulse rounded-2xl border border-border/30 bg-background/25" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (errorMessage) {
    return (
      <Card className="border-red-500/25 bg-red-500/5">
        <CardContent className="py-5 text-sm text-red-200/80">
          {errorMessage}
        </CardContent>
      </Card>
    )
  }

  if (!lookup) {
    return null
  }

  return (
    <Card className="glass-card border-border/40">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-xl font-bold tracking-tight">{lookup.target.domain}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground/70">
              Token ID is the labelhash of <span className="font-mono">{lookup.target.label}</span>. Explorer search is limited, so this view reads the registrar, root registry, and resolver contracts directly.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className={lookup.status === "available"
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                : lookup.status === "grace-period"
                  ? "border-amber-500/25 bg-amber-500/10 text-amber-300"
                  : "border-primary/25 bg-primary/10 text-primary"}
            >
              {formatDomainStatus(lookup.status)}
            </Badge>
            <Badge variant="outline" className="border-border/40 bg-background/30 text-foreground/80">
              {formatRelativeYears(lookup.durationYears)} quote
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Requested rent</p>
            <p className="mt-2 font-mono text-lg font-semibold">{formatUsdcAmount(lookup.rentPrice)}</p>
          </div>
          <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Current owner</p>
            <p className="mt-2 font-mono text-sm font-semibold">{formatAddress(lookup.ownerAddress)}</p>
          </div>
          <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Expiration</p>
            <p className="mt-2 text-sm font-semibold">{formatTimestamp(lookup.expiresAt)}</p>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)]">
          <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Pricing and lifecycle
            </div>

            <dl className="mt-3 space-y-2 text-sm text-muted-foreground/75">
              <div className="flex items-center justify-between gap-3">
                <dt>Annual base tier</dt>
                <dd className="font-mono text-foreground/85">{formatUsdcAmount(lookup.annualBasePrice)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>3-character annual</dt>
                <dd className="font-mono text-foreground/85">{formatUsdcAmount(lookup.namespaceSnapshot.threeCharacterPrice)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>4-character annual</dt>
                <dd className="font-mono text-foreground/85">{formatUsdcAmount(lookup.namespaceSnapshot.fourCharacterPrice)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>5+ character annual</dt>
                <dd className="font-mono text-foreground/85">{formatUsdcAmount(lookup.namespaceSnapshot.fivePlusCharacterPrice)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Grace period ends</dt>
                <dd className="text-foreground/85">{formatTimestamp(lookup.graceEndsAt)}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Globe2 className="h-4 w-4 text-cyan-300" />
              Resolver and namespace info
            </div>

            <dl className="mt-3 space-y-2 text-sm text-muted-foreground/75">
              <div className="flex items-center justify-between gap-3">
                <dt>Resolver</dt>
                <dd className="font-mono text-foreground/85">{formatAddress(lookup.resolverAddress)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Resolved address</dt>
                <dd className="font-mono text-foreground/85">{formatAddress(lookup.resolvedAddress)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Namespace owner</dt>
                <dd className="font-mono text-foreground/85">{formatAddress(lookup.namespaceSnapshot.namespaceOwner)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Namespace active</dt>
                <dd className="text-foreground/85">{lookup.namespaceSnapshot.active ? "yes" : "no"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>Whitelisted flag</dt>
                <dd className="text-foreground/85">{lookup.namespaceSnapshot.whitelisted ? "yes" : "no"}</dd>
              </div>
            </dl>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}