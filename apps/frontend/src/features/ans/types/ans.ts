import type { Address } from "viem"

export const ANS_NAMESPACE_KEYS = ["arc", "wizpay"] as const

export type AnsNamespaceKey = (typeof ANS_NAMESPACE_KEYS)[number]
export type TrackedAnsDomainSource = "search" | "register" | "manual"
export type AnsDomainStatus = "available" | "registered" | "grace-period"

export interface AnsNamespaceContracts {
  key: AnsNamespaceKey
  label: string
  suffix: `.${AnsNamespaceKey}`
  registrar: Address
  controller: Address
  configuredVault: Address | null
}

export interface AnsContractsConfig {
  chainId: number
  rootRegistry: Address
  registry: Address
  resolver: Address
  usdc: Address
  namespaces: Record<AnsNamespaceKey, AnsNamespaceContracts>
}

export interface AnsNamespaceSnapshot {
  key: AnsNamespaceKey
  label: string
  suffix: `.${AnsNamespaceKey}`
  namespaceOwner: Address
  registrar: Address
  controller: Address
  vault: Address
  defaultResolver: Address
  active: boolean
  isGlobal: boolean
  whitelisted: boolean
  blacklisted: boolean
  threeCharacterPrice: bigint
  fourCharacterPrice: bigint
  fivePlusCharacterPrice: bigint
  promoEnabled: boolean
  promoDiscountBps: number
  promoStartsAt: number
  promoEndsAt: number
}

export interface AnsDomainTarget {
  label: string
  namespace: AnsNamespaceKey
  domain: string
  labelLength: number
}

export interface ParsedAnsSearchInput {
  normalizedInput: string
  error: string | null
  target: AnsDomainTarget | null
}

export interface AnsDomainLookup {
  target: AnsDomainTarget
  tokenId: bigint
  node: `0x${string}`
  durationYears: number
  durationSeconds: bigint
  annualBasePrice: bigint
  rentPrice: bigint
  available: boolean
  ownerAddress: Address | null
  expiresAt: bigint | null
  isExpired: boolean
  inGracePeriod: boolean
  graceEndsAt: bigint | null
  resolverAddress: Address | null
  resolvedAddress: Address | null
  status: AnsDomainStatus
  namespaceSnapshot: AnsNamespaceSnapshot
}

export interface TrackedAnsDomain {
  domain: string
  walletAddress: Address | null
  lastTouchedAt: number
  source: TrackedAnsDomainSource
}

export interface AnsRegistrationActivityRecord {
  id: string
  domain: string
  walletAddress: Address | null
  txHash: string | null
  amount: string
  durationYears: number
  timestampMs: number
}

export interface AnsBackendSupportItem {
  label: AnsNamespaceKey
  suffix: `.${AnsNamespaceKey}`
}

export interface AnsBackendResolution {
  normalizedDomain: string
  label: string
  namespace: string | null
  isSupportedNamespace: boolean
  resolvedAddress: string | null
  resolutionStatus:
    | "resolved"
    | "name_not_found"
    | "resolver_unavailable"
    | "unsupported_namespace"
}

export interface AnsRegistrationConfirmation {
  ownerAddress: Address
  expiresAt: bigint
}