"use client"

import { useEffect, useState } from "react"

import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress"

import { AnsDomainSearchForm } from "../components/AnsDomainSearchForm"
import { AnsLookupDetailsCard } from "../components/AnsLookupDetailsCard"
import { AnsRegistrationCard } from "../components/AnsRegistrationCard"
import { AnsRouteShell } from "../components/AnsRouteShell"
import { useAnsDomainLookup } from "../hooks/useAnsDomainLookup"
import { useAnsRegistration } from "../hooks/useAnsRegistration"
import { useTrackedAnsDomains } from "../hooks/useTrackedAnsDomains"
import type { AnsNamespaceKey } from "../types/ans"

export function AnsRegisterPage() {
  const [inputValue, setInputValue] = useState("")
  const [namespace, setNamespace] = useState<AnsNamespaceKey>("arc")
  const [durationYears, setDurationYears] = useState(1)
  const [submittedQuery, setSubmittedQuery] = useState<{
    searchValue: string
    namespace: AnsNamespaceKey
    durationYears: number
    requestId: number
  }>({
    searchValue: "",
    namespace: "arc",
    durationYears: 1,
    requestId: 0,
  })
  const { walletAddress } = useActiveWalletAddress()
  const { trackDomain } = useTrackedAnsDomains(walletAddress)

  const lookupQuery = useAnsDomainLookup({
    searchValue: submittedQuery.searchValue,
    defaultNamespace: submittedQuery.namespace,
    durationYears: submittedQuery.durationYears,
    requestId: submittedQuery.requestId,
    enabled: submittedQuery.requestId > 0,
  })

  const lookupErrorMessage =
    lookupQuery.error instanceof Error
      ? lookupQuery.error.message
      : lookupQuery.namespaceSnapshotQuery.error instanceof Error
        ? lookupQuery.namespaceSnapshotQuery.error.message
        : null

  const lookupIsLoading =
    lookupQuery.isLoading || lookupQuery.namespaceSnapshotQuery.isLoading

  const registration = useAnsRegistration({
    lookup: lookupQuery.data,
    onRegistered: (domain) => trackDomain(domain, "register", walletAddress),
  })
  const resetRegistrationFeedback = registration.resetFeedback

  useEffect(() => {
    resetRegistrationFeedback()
  }, [lookupQuery.data?.target.domain, lookupQuery.data?.durationYears, resetRegistrationFeedback])

  return (
    <AnsRouteShell
      title="Register ANS names"
      description="This flow approves USDC for the active namespace controller, then submits the live on-chain registration call. No smart contract logic is forked or wrapped by a separate service."
    >
      <AnsDomainSearchForm
        inputValue={inputValue}
        namespace={namespace}
        durationYears={durationYears}
        isBusy={lookupIsLoading || registration.step === "approving" || registration.step === "registering"}
        submitLabel="Load registration quote"
        onInputValueChange={setInputValue}
        onNamespaceChange={setNamespace}
        onDurationYearsChange={setDurationYears}
        onSubmit={() =>
          setSubmittedQuery({
            searchValue: inputValue,
            namespace,
            durationYears,
            requestId: Date.now(),
          })
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.95fr)]">
        <AnsLookupDetailsCard
          parsedSearch={lookupQuery.parsedSearch}
          lookup={lookupQuery.data}
          isLoading={lookupIsLoading}
          errorMessage={lookupErrorMessage}
        />

        <AnsRegistrationCard
          approvalHash={registration.approvalHash}
          walletAddress={walletAddress}
          lookup={lookupQuery.data}
          allowance={registration.allowance}
          balance={registration.balance}
          requiredAmount={registration.requiredAmount}
          needsApproval={registration.needsApproval}
          insufficientBalance={registration.insufficientBalance}
          step={registration.step}
          submissionHash={registration.submissionHash}
          errorMessage={registration.errorMessage}
          confirmation={registration.confirmation}
          registrationHash={registration.registrationHash}
          onSubmit={registration.submit}
        />
      </div>
    </AnsRouteShell>
  )
}
