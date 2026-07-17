"use client"

import { useQuery } from "@tanstack/react-query"
import { usePublicClient } from "wagmi"

import { arcTestnet } from "@/lib/wagmi"

import {
  fetchAnsNamespaceSnapshot,
  getAnsReadErrorMessage,
} from "../resolvers/ans-resolution"
import { getAnsContractsConfig } from "../services/ans-config"
import type { AnsNamespaceKey } from "../types/ans"

export function useAnsNamespaceSnapshot(
  namespace: AnsNamespaceKey,
  enabled = true,
  requestId = 0
) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id })
  const contracts = getAnsContractsConfig()

  return useQuery({
    queryKey: ["ans", "namespace", namespace, contracts.rootRegistry, requestId],
    enabled: enabled && Boolean(publicClient),
    queryFn: async () => {
      try {
        return await fetchAnsNamespaceSnapshot(publicClient!, contracts, namespace)
      } catch (error) {
        throw new Error(getAnsReadErrorMessage(error))
      }
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  })
}
