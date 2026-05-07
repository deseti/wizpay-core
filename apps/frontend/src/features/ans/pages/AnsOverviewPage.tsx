"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Network, Server } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

import { AnsNamespaceCard } from "../components/AnsNamespaceCard"
import { AnsRouteShell } from "../components/AnsRouteShell"
import { useAnsNamespaceSnapshot } from "../hooks/useAnsNamespaceSnapshot"
import { fetchAnsBackendSupport } from "../services/ans-backend"

export function AnsOverviewPage() {
  const arcSnapshotQuery = useAnsNamespaceSnapshot("arc")
  const wizpaySnapshotQuery = useAnsNamespaceSnapshot("wizpay")
  const backendSupportQuery = useQuery({
    queryKey: ["ans", "backend-support"],
    queryFn: fetchAnsBackendSupport,
    retry: false,
    staleTime: 60_000,
  })

  return (
    <AnsRouteShell
      title="Arc Name Service"
      description="Initial ANS integration stays inside the existing WizPay apps as a modular monolith. Reads come directly from the production-tested contracts, while the backend exposes only lightweight helper endpoints for resolution and validation."
    >
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Current scope</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Network className="h-4 w-4 text-primary" />
                Namespaces
              </div>
              <p className="mt-2 text-sm text-muted-foreground/75">Only .arc and .wizpay are active in this release.</p>
            </div>
            <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Server className="h-4 w-4 text-cyan-300" />
                Read path
              </div>
              <p className="mt-2 text-sm text-muted-foreground/75">Availability, ownership, expiry, resolver data, and pricing are direct RPC reads. No indexer or cache sits in the middle yet.</p>
            </div>
            <div className="rounded-2xl border border-border/30 bg-background/25 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <ArrowRight className="h-4 w-4 text-emerald-300" />
                Write path
              </div>
              <p className="mt-2 text-sm text-muted-foreground/75">Registration uses the existing wallet executor, approves USDC, then calls the deployed namespace controller.</p>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Start from exact names</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild className="w-full justify-between">
              <Link href="/ans/search">
                Search availability and ownership
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-between border-border/40 bg-background/35">
              <Link href="/ans/register">
                Approve USDC and register a name
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-between border-border/40 bg-background/35">
              <Link href="/ans/my-domains">
                Track exact domains locally
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>

            {backendSupportQuery.data ? (
              <div className="rounded-2xl border border-border/30 bg-background/25 p-4 text-sm text-muted-foreground/75">
                Backend helper endpoint is live for: {backendSupportQuery.data.map((item) => item.suffix).join(", ")}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <AnsNamespaceCard snapshot={arcSnapshotQuery.data} isLoading={arcSnapshotQuery.isLoading} />
        <AnsNamespaceCard snapshot={wizpaySnapshotQuery.data} isLoading={wizpaySnapshotQuery.isLoading} />
      </section>
    </AnsRouteShell>
  )
}