"use client"

import { CheckCircle2, ExternalLink, MessageCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { buildXShareUrl } from "@/lib/social"
import { EXPLORER_BASE_URL, formatCompactAddress, getExplorerTxUrl } from "@/lib/wizpay"

import type { AnsRegistrationConfirmation } from "../types/ans"
import { formatTimestamp, formatUsdcAmount } from "../utils/format"

export function AnsRegistrationSuccessDialog({
  approvalHash,
  confirmation,
  domain,
  isOpen,
  onClose,
  registrationHash,
  requiredAmount,
}: {
  approvalHash: string | null
  confirmation: AnsRegistrationConfirmation | null
  domain: string
  isOpen: boolean
  onClose: () => void
  registrationHash: string | null
  requiredAmount: bigint
}) {
  if (!isOpen || !confirmation) {
    return null
  }

  const explorerUrl = getExplorerTxUrl(registrationHash)
  const approvalExplorerUrl = getExplorerTxUrl(approvalHash)
  // Fallback: link to owner address page when we only have a Circle reference ID
  const ownerExplorerUrl = explorerUrl
    ? null
    : `${EXPLORER_BASE_URL}/address/${confirmation.ownerAddress}`
  const primaryExplorerUrl = explorerUrl ?? ownerExplorerUrl
  const xShareUrl = buildXShareUrl({
    summary: `Just registered ${domain} on ANS via WizPay.`,
    explorerUrl: primaryExplorerUrl,
    secondaryText: registrationHash ? `Registration tx: ${registrationHash}` : null,
  })

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
        <div className="relative overflow-hidden p-6">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-400 ring-1 ring-emerald-400/20">
            <CheckCircle2 className="h-7 w-7" />
          </div>

          <DialogHeader className="space-y-2">
            <DialogTitle className="text-xl">ANS Registration Successful</DialogTitle>
            <DialogDescription>
              {domain} has been confirmed on Arc Testnet and now points at the active wallet.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Domain</span>
                <span className="font-medium">{domain}</span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Registration cost</span>
                <span className="font-mono font-medium">{formatUsdcAmount(requiredAmount)}</span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Owner</span>
                <span className="font-mono font-medium">
                  {formatCompactAddress(confirmation.ownerAddress)}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground/70">Expires</span>
                <span className="font-medium">{formatTimestamp(confirmation.expiresAt)}</span>
              </div>
            </div>

            {approvalHash ? (
              <div className="flex items-center justify-between rounded-2xl border border-border/40 bg-background/45 px-4 py-3 text-sm">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">
                    Approval tx
                  </p>
                  <p className="mt-1 font-mono text-foreground/80">
                    {formatCompactAddress(approvalHash)}
                  </p>
                </div>
                {approvalExplorerUrl ? (
                  <a
                    href={approvalExplorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-emerald-400 transition-colors hover:text-emerald-300"
                  >
                    Explorer <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </div>
            ) : null}

            {registrationHash ? (
              <div className="flex items-center justify-between rounded-2xl border border-border/40 bg-background/45 px-4 py-3 text-sm">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">
                    Registration tx
                  </p>
                  <p className="mt-1 font-mono text-foreground/80">
                    {formatCompactAddress(registrationHash)}
                  </p>
                </div>
                {primaryExplorerUrl ? (
                  <a
                    href={primaryExplorerUrl!}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-emerald-400 transition-colors hover:text-emerald-300"
                  >
                    {explorerUrl ? "Explorer" : "ArcScan"} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              <Button
                className="w-full gap-2 bg-[#1DA1F2] text-white hover:bg-[#1A8CD8]"
                asChild
              >
                <a href={xShareUrl} target="_blank" rel="noreferrer">
                  <MessageCircle className="h-4 w-4" />
                  Share to X (Twitter)
                </a>
              </Button>

              <div className="flex flex-col gap-3 sm:flex-row">
                {primaryExplorerUrl ? (
                  <Button asChild className="flex-1">
                    <a href={primaryExplorerUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      {explorerUrl ? "View transaction" : "View on ArcScan"}
                    </a>
                  </Button>
                ) : null}
                <Button variant="outline" className="flex-1" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}