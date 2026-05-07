"use client"

import { useQuery } from "@tanstack/react-query"
import { usePublicClient } from "wagmi"

import { arcTestnet } from "@/lib/wagmi"

import { fetchAnsNamespaceSnapshot } from "../resolvers/ans-resolution"
import { getAnsContractsConfig } from "../services/ans-config"
import type { AnsNamespaceKey } from "../types/ans"

export function useAnsNamespaceSnapshot(namespace: AnsNamespaceKey) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id })
  const contracts = getAnsContractsConfig()

  return useQuery({
    queryKey: ["ans", "namespace", namespace, contracts.rootRegistry],
    enabled: Boolean(publicClient),
    queryFn: () =>
      fetchAnsNamespaceSnapshot(publicClient!, contracts, namespace),
    staleTime: 30_000,
  })
}