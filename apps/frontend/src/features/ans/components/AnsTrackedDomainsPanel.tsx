"use client"

import { Trash2, WalletCards } from "lucide-react"
import type { Address } from "viem"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyStateView } from "@/components/ui/empty-state"

import { useAnsDomainLookup } from "../hooks/useAnsDomainLookup"
import type { TrackedAnsDomain } from "../types/ans"
import { formatDomainStatus, formatTimestamp } from "../utils/format"

function TrackedDomainRow({
  domain,
  walletAddress,
  onRemove,
}: {
  domain: TrackedAnsDomain
  walletAddress?: Address
  onRemove: (domain: string) => void
}) {
  const lookupQuery = useAnsDomainLookup({
    searchValue: domain.domain,
    defaultNamespace: "arc",
    durationYears: 1,
    enabled: true,
  })

  const lookup = lookupQuery.data
  const ownedByActiveWallet = Boolean(
    walletAddress && lookup?.ownerAddress?.toLowerCase() === walletAddress.toLowerCase()
  )
  const ownerLabel = lookupQuery.isLoading
    ? "Loading..."
    : lookup?.ownerAddress
      ? `${lookup.ownerAddress.slice(0, 6)}…${lookup.ownerAddress.slice(-4)}`
      : lookupQuery.error
        ? "Lookup failed"
        : "Not registered"
  const expirationLabel = lookupQuery.isLoading
    ? "Loading..."
    : lookup
      ? formatTimestamp(lookup.expiresAt ?? null)
      : lookupQuery.error
        ? "Lookup failed"
        : "Not registered"
  const resolverLabel = lookupQuery.isLoading
    ? "Loading..."
    : lookup?.resolvedAddress
      ? `${lookup.resolvedAddress.slice(0, 6)}…${lookup.resolvedAddress.slice(-4)}`
      : lookupQuery.error
        ? "Lookup failed"
        : "Not set"

  return (
    <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-sm font-semibold text-foreground">{domain.domain}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Tracked from {domain.source} on {new Date(domain.lastTouchedAt).toLocaleString()}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {lookup ? (
            <Badge variant="outline" className="border-border/40 bg-background/30 text-foreground/80">
              {formatDomainStatus(lookup.status)}
            </Badge>
          ) : lookupQuery.isLoading ? (
            <Badge variant="outline" className="border-border/40 bg-background/30 text-foreground/80">
              Loading
            </Badge>
          ) : lookupQuery.error ? (
            <Badge variant="outline" className="border-red-500/25 bg-red-500/10 text-red-300">
              Lookup failed
            </Badge>
          ) : null}
          {ownedByActiveWallet ? (
            <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/10 text-emerald-300">
              Owned by active wallet
            </Badge>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground/75"
            onClick={() => onRemove(domain.domain)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Owner</p>
          <p className="mt-2 font-mono text-xs text-foreground/85">{ownerLabel}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Expiration</p>
          <p className="mt-2 text-xs text-foreground/85">{expirationLabel}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Resolver address</p>
          <p className="mt-2 font-mono text-xs text-foreground/85">{resolverLabel}</p>
        </div>
      </div>
    </div>
  )
}

export function AnsTrackedDomainsPanel({
  domains,
  walletAddress,
  onRemove,
}: {
  domains: TrackedAnsDomain[]
  walletAddress?: Address
  onRemove: (domain: string) => void
}) {
  if (domains.length === 0) {
    return (
      <EmptyStateView
        icon={<WalletCards className="h-7 w-7 text-primary/70" />}
        title="No tracked ANS names yet"
        description="This page is intentionally local-first until an indexer exists. Search or register a name, or manually add an exact domain to keep watching it here."
      />
    )
  }

  return (
    <Card className="glass-card border-border/40">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Tracked ANS domains</CardTitle>
        <p className="text-sm text-muted-foreground/75">
          This is not a full portfolio index. It re-checks only the exact domains stored in this browser and compares them against the active wallet when one is connected.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {domains.map((domain) => (
          <TrackedDomainRow
            key={domain.domain}
            domain={domain}
            walletAddress={walletAddress}
            onRemove={onRemove}
          />
        ))}
      </CardContent>
    </Card>
  )
}