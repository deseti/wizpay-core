import { backendFetch } from "@/lib/backend-api"

import type { AnsBackendResolution, AnsBackendSupportItem } from "../types/ans"

export function fetchAnsBackendSupport() {
  return backendFetch<AnsBackendSupportItem[]>("/ans/support")
}

export function resolveAnsDomainViaBackend(domain: string) {
  return backendFetch<AnsBackendResolution | null>(
    `/ans/resolve?domain=${encodeURIComponent(domain)}`
  )
}