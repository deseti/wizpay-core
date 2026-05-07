"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react"
import type { Address } from "viem"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyStateView } from "@/components/ui/empty-state"
import { useToast } from "@/hooks/use-toast"

import { AnsRegistrationSuccessDialog } from "./AnsRegistrationSuccessDialog"
import type {
  AnsDomainLookup,
  AnsRegistrationConfirmation,
} from "../types/ans"
import { formatTimestamp, formatUsdcAmount } from "../utils/format"

function formatAddress(value?: Address) {
  if (!value) {
    return "Connect a wallet"
  }

  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

export function AnsRegistrationCard({
  approvalHash,
  walletAddress,
  lookup,
  allowance,
  balance,
  requiredAmount,
  needsApproval,
  insufficientBalance,
  step,
  submissionHash,
  errorMessage,
  confirmation,
  registrationHash,
  onSubmit,
}: {
  approvalHash: string | null
  walletAddress?: Address
  lookup: AnsDomainLookup | null | undefined
  allowance: bigint
  balance: bigint
  requiredAmount: bigint
  needsApproval: boolean
  insufficientBalance: boolean
  step: "idle" | "approving" | "registering" | "success" | "error"
  submissionHash: string | null
  errorMessage: string | null
  confirmation: AnsRegistrationConfirmation | null
  registrationHash: string | null
  onSubmit: () => Promise<unknown>
}) {
  const { toast } = useToast()
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false)
  const isApproving = step === "approving"
  const isRegistering = step === "registering"
  const isBusy = isApproving || isRegistering

  useEffect(() => {
    if (step === "success" && confirmation) {
      setIsSuccessDialogOpen(true)
      return
    }

    if (!confirmation) {
      setIsSuccessDialogOpen(false)
    }
  }, [confirmation, step])

  if (!lookup) {
    return (
      <EmptyStateView
        icon={<ShieldCheck className="h-7 w-7 text-primary/70" />}
        title="Search an available ANS name first"
        description="Registration stays disabled until you fetch an exact on-chain quote for an available .arc or .wizpay name."
      />
    )
  }

  const canSubmit = Boolean(walletAddress) && lookup.available && !insufficientBalance && !isBusy

  async function handleSubmit() {
    try {
      await onSubmit()
    } catch (error) {
      toast({
        title: "Registration failed",
        description:
          error instanceof Error
            ? error.message
            : "Approve and register flow failed.",
        variant: "destructive",
      })
    }
  }

  return (
    <>
      <Card className="glass-card border-border/40">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Approve and register</CardTitle>
          <p className="text-sm text-muted-foreground/75">
            The active wallet approves USDC if needed, then immediately submits the live on-chain registration. The registration flow sets the current default resolver and points the name at the same active wallet address.
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Active wallet</p>
              <p className="mt-2 font-mono text-sm font-semibold">{formatAddress(walletAddress)}</p>
            </div>
            <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Wallet USDC</p>
              <p className="mt-2 font-mono text-sm font-semibold">{formatUsdcAmount(balance)}</p>
            </div>
            <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Allowance</p>
              <p className="mt-2 font-mono text-sm font-semibold">{formatUsdcAmount(allowance)}</p>
            </div>
            <div className="rounded-2xl border border-border/30 bg-background/25 p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Registration cost</p>
              <p className="mt-2 font-mono text-sm font-semibold">{formatUsdcAmount(requiredAmount)}</p>
            </div>
          </div>

          {!walletAddress ? (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100/85">
              Connect the active wallet first. Circle app wallet and external Arc wallets are both supported through the existing transaction executor.
            </div>
          ) : null}

          {!lookup.available ? (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100/85">
              This name is not currently available. Search a different exact label before trying to register.
            </div>
          ) : null}

          {insufficientBalance ? (
            <div className="rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-100/85">
              The active wallet does not hold enough USDC to cover the current quoted rent.
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-100/85">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <span>{errorMessage}</span>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <Button
              className="w-full gap-2"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {isApproving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Approving USDC...
                </>
              ) : isRegistering ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Registering...
                </>
              ) : needsApproval ? (
                <>
                  <ShieldCheck className="h-4 w-4" />
                  Approve &amp; Register {lookup.target.domain}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Register {lookup.target.domain}
                </>
              )}
            </Button>

            <p className="text-xs text-muted-foreground/65">
              If approval is still required, Circle or your external wallet will prompt twice: once for approval and once for the registration transaction.
            </p>
          </div>

          {submissionHash ? (
            <div className="rounded-2xl border border-border/30 bg-background/25 p-4 text-sm text-muted-foreground/75">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/55">Latest submission</p>
              <p className="mt-2 font-mono text-foreground/85 break-all">{submissionHash}</p>
            </div>
          ) : null}

          {confirmation ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-100/90">
              <p className="font-semibold">Registration confirmed on-chain.</p>
              <p className="mt-1">Owner: <span className="font-mono">{formatAddress(confirmation.ownerAddress)}</span></p>
              <p className="mt-1">Expires: {formatTimestamp(confirmation.expiresAt)}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <AnsRegistrationSuccessDialog
        approvalHash={approvalHash}
        confirmation={confirmation}
        domain={lookup.target.domain}
        isOpen={isSuccessDialogOpen}
        onClose={() => setIsSuccessDialogOpen(false)}
        registrationHash={registrationHash}
        requiredAmount={requiredAmount}
      />
    </>
  )
}