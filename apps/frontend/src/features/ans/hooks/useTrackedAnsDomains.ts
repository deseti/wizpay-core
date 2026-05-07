"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { Address } from "viem"

import type { TrackedAnsDomain, TrackedAnsDomainSource } from "../types/ans"
import {
  readTrackedAnsDomains,
  removeTrackedAnsDomain,
  upsertTrackedAnsDomain,
} from "../utils/storage"

export function useTrackedAnsDomains(walletAddress?: Address) {
  const [trackedDomains, setTrackedDomains] = useState<TrackedAnsDomain[]>([])

  useEffect(() => {
    setTrackedDomains(readTrackedAnsDomains())
  }, [])

  const trackDomain = useCallback(
    (domain: string, source: TrackedAnsDomainSource, ownerAddress?: Address) => {
      setTrackedDomains(upsertTrackedAnsDomain(domain, source, ownerAddress ?? walletAddress))
    },
    [walletAddress]
  )

  const removeDomain = useCallback((domain: string) => {
    setTrackedDomains(removeTrackedAnsDomain(domain))
  }, [])

  const walletTrackedDomains = useMemo(() => {
    if (!walletAddress) {
      return trackedDomains
    }

    const normalizedWalletAddress = walletAddress.toLowerCase()

    return trackedDomains.filter(
      (entry) =>
        !entry.walletAddress ||
        entry.walletAddress.toLowerCase() === normalizedWalletAddress
    )
  }, [trackedDomains, walletAddress])

  return {
    trackedDomains,
    walletTrackedDomains,
    trackDomain,
    removeDomain,
  }
}