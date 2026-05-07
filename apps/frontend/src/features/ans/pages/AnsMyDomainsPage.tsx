"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress"
import { useToast } from "@/hooks/use-toast"

import { AnsRouteShell } from "../components/AnsRouteShell"
import { AnsTrackedDomainsPanel } from "../components/AnsTrackedDomainsPanel"
import { useTrackedAnsDomains } from "../hooks/useTrackedAnsDomains"
import { parseAnsSearchInput } from "../utils/domain"

export function AnsMyDomainsPage() {
  const [manualDomain, setManualDomain] = useState("")
  const { walletAddress } = useActiveWalletAddress()
  const { walletTrackedDomains, trackDomain, removeDomain } = useTrackedAnsDomains(walletAddress)
  const { toast } = useToast()

  function handleTrackDomain() {
    const parsed = parseAnsSearchInput(manualDomain, "arc")
    if (parsed.error || !parsed.target) {
      toast({
        title: "Domain cannot be tracked",
        description: parsed.error ?? "Enter an exact .arc or .wizpay name.",
        variant: "destructive",
      })
      return
    }

    trackDomain(parsed.target.domain, "manual", walletAddress)
    setManualDomain("")
  }

  return (
    <AnsRouteShell
      title="My domains"
      description="Until indexing exists, this page is a tracked-domain surface rather than a full wallet portfolio. It re-checks the exact names you store in this browser against the live registrar and resolver contracts."
    >
      <Card className="glass-card border-border/40">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Track an exact domain</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-2">
            <Label htmlFor="ans-track-domain">Exact .arc or .wizpay name</Label>
            <Input
              id="ans-track-domain"
              value={manualDomain}
              onChange={(event) => setManualDomain(event.target.value)}
              placeholder="payroll.arc"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-10"
            />
          </div>

          <Button className="h-10" onClick={handleTrackDomain}>
            Track domain
          </Button>
        </CardContent>
      </Card>

      <AnsTrackedDomainsPanel
        domains={walletTrackedDomains}
        walletAddress={walletAddress}
        onRemove={removeDomain}
      />
    </AnsRouteShell>
  )
}