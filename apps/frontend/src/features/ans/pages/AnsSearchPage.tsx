"use client"

import { useEffect, useState } from "react"

import { AnsDomainSearchForm } from "../components/AnsDomainSearchForm"
import { AnsLookupDetailsCard } from "../components/AnsLookupDetailsCard"
import { AnsRouteShell } from "../components/AnsRouteShell"
import { useAnsDomainLookup } from "../hooks/useAnsDomainLookup"
import { useTrackedAnsDomains } from "../hooks/useTrackedAnsDomains"
import type { AnsNamespaceKey } from "../types/ans"

export function AnsSearchPage() {
  const [inputValue, setInputValue] = useState("")
  const [submittedSearch, setSubmittedSearch] = useState("")
  const [namespace, setNamespace] = useState<AnsNamespaceKey>("arc")
  const [durationYears, setDurationYears] = useState(1)
  const { trackDomain } = useTrackedAnsDomains()

  const lookupQuery = useAnsDomainLookup({
    searchValue: submittedSearch,
    defaultNamespace: namespace,
    durationYears,
    enabled: Boolean(submittedSearch),
  })

  const lookupErrorMessage =
    lookupQuery.error instanceof Error
      ? lookupQuery.error.message
      : lookupQuery.namespaceSnapshotQuery.error instanceof Error
        ? lookupQuery.namespaceSnapshotQuery.error.message
        : null

  const lookupIsLoading =
    lookupQuery.isLoading || lookupQuery.namespaceSnapshotQuery.isLoading

  useEffect(() => {
    if (lookupQuery.data?.target.domain) {
      trackDomain(lookupQuery.data.target.domain, "search")
    }
  }, [lookupQuery.data?.target.domain, trackDomain])

  return (
    <AnsRouteShell
      title="Search ANS names"
      description="Query exact ANS names against the current deployed contracts. This view is deliberately exact-match only until event indexing exists."
    >
      <AnsDomainSearchForm
        inputValue={inputValue}
        namespace={namespace}
        durationYears={durationYears}
        isBusy={lookupIsLoading}
        submitLabel="Search name"
        onInputValueChange={setInputValue}
        onNamespaceChange={setNamespace}
        onDurationYearsChange={setDurationYears}
        onSubmit={() => setSubmittedSearch(inputValue)}
      />

      <AnsLookupDetailsCard
        parsedSearch={lookupQuery.parsedSearch}
        lookup={lookupQuery.data}
        isLoading={lookupIsLoading}
        errorMessage={lookupErrorMessage}
      />
    </AnsRouteShell>
  )
}