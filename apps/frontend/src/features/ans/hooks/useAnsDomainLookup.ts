"use client"

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { usePublicClient } from "wagmi"

import { arcTestnet } from "@/lib/wagmi"

import {
  fetchAnsDomainLookup,
  getAnsReadErrorMessage,
} from "../resolvers/ans-resolution"
import { getAnsContractsConfig } from "../services/ans-config"
import type { AnsNamespaceKey } from "../types/ans"
import { parseAnsSearchInput } from "../utils/domain"
import { useAnsNamespaceSnapshot } from "./useAnsNamespaceSnapshot"

export function useAnsDomainLookup({
  searchValue,
  defaultNamespace,
  durationYears,
  requestId = 0,
  enabled = true,
}: {
  searchValue: string
  defaultNamespace: AnsNamespaceKey
  durationYears: number
  requestId?: number
  enabled?: boolean
}) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id })
  const contracts = getAnsContractsConfig()

  const parsedSearch = useMemo(
    () => parseAnsSearchInput(searchValue, defaultNamespace),
    [defaultNamespace, searchValue]
  )

  const namespace = parsedSearch.target?.namespace ?? defaultNamespace
  const namespaceSnapshotQuery = useAnsNamespaceSnapshot(
    namespace,
    enabled && Boolean(parsedSearch.target) && !parsedSearch.error,
    requestId
  )

  const lookupQuery = useQuery({
    queryKey: [
      "ans",
      "lookup",
      parsedSearch.target?.domain,
      durationYears,
      namespaceSnapshotQuery.data?.controller,
      requestId,
    ],
    enabled:
      enabled &&
      Boolean(publicClient) &&
      Boolean(parsedSearch.target) &&
      !parsedSearch.error &&
      Boolean(namespaceSnapshotQuery.data),
    queryFn: async () => {
      try {
        return await fetchAnsDomainLookup(
          publicClient!,
          contracts,
          parsedSearch.target!,
          durationYears,
          namespaceSnapshotQuery.data!
        )
      } catch (error) {
        throw new Error(getAnsReadErrorMessage(error))
      }
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 10_000,
  })

  return {
    ...lookupQuery,
    parsedSearch,
    namespaceSnapshotQuery,
  }
}
