import type { Address } from "viem"

import { ANS_MAX_TRACKED_DOMAINS } from "../pricing/constants"
import type {
  AnsRegistrationActivityRecord,
  TrackedAnsDomain,
  TrackedAnsDomainSource,
} from "../types/ans"

const TRACKED_ANS_DOMAINS_STORAGE_KEY = "wizpay:ans:tracked-domains"
const ANS_REGISTRATION_ACTIVITY_STORAGE_KEY = "wizpay:ans:registration-activity"
const MAX_ANS_REGISTRATION_ACTIVITY_ITEMS = 50

export const ANS_ACTIVITY_UPDATED_EVENT = "wizpay:ans:activity-updated"

function hasWindow() {
  return typeof window !== "undefined"
}

function emitAnsActivityUpdated() {
  if (!hasWindow()) {
    return
  }

  window.dispatchEvent(new CustomEvent(ANS_ACTIVITY_UPDATED_EVENT))
}

export function readTrackedAnsDomains(): TrackedAnsDomain[] {
  if (!hasWindow()) {
    return []
  }

  try {
    const rawValue = window.localStorage.getItem(TRACKED_ANS_DOMAINS_STORAGE_KEY)
    if (!rawValue) {
      return []
    }

    const parsed = JSON.parse(rawValue) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(isTrackedDomain)
  } catch {
    return []
  }
}

export function writeTrackedAnsDomains(domains: TrackedAnsDomain[]) {
  if (!hasWindow()) {
    return
  }

  window.localStorage.setItem(
    TRACKED_ANS_DOMAINS_STORAGE_KEY,
    JSON.stringify(domains.slice(0, ANS_MAX_TRACKED_DOMAINS))
  )
}

export function readAnsRegistrationActivity(): AnsRegistrationActivityRecord[] {
  if (!hasWindow()) {
    return []
  }

  try {
    const rawValue = window.localStorage.getItem(ANS_REGISTRATION_ACTIVITY_STORAGE_KEY)
    if (!rawValue) {
      return []
    }

    const parsed = JSON.parse(rawValue) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(isAnsRegistrationActivityRecord)
  } catch {
    return []
  }
}

export function writeAnsRegistrationActivity(entries: AnsRegistrationActivityRecord[]) {
  if (!hasWindow()) {
    return
  }

  window.localStorage.setItem(
    ANS_REGISTRATION_ACTIVITY_STORAGE_KEY,
    JSON.stringify(entries.slice(0, MAX_ANS_REGISTRATION_ACTIVITY_ITEMS))
  )

  emitAnsActivityUpdated()
}

export function recordAnsRegistrationActivity({
  amount,
  domain,
  durationYears,
  timestampMs = Date.now(),
  txHash,
  walletAddress,
}: {
  amount: bigint
  domain: string
  durationYears: number
  timestampMs?: number
  txHash?: string | null
  walletAddress?: Address
}) {
  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedDomain) {
    return []
  }

  const normalizedWalletAddress = walletAddress?.toLowerCase() as Address | undefined
  const normalizedTxHash = txHash?.trim() || null
  const nextEntry: AnsRegistrationActivityRecord = {
    id:
      normalizedTxHash?.toLowerCase() ??
      `ans:${normalizedWalletAddress ?? "unknown"}:${normalizedDomain}:${timestampMs}`,
    domain: normalizedDomain,
    walletAddress: normalizedWalletAddress ?? null,
    txHash: normalizedTxHash,
    amount: amount.toString(),
    durationYears,
    timestampMs,
  }

  const nextEntries = [
    nextEntry,
    ...readAnsRegistrationActivity().filter((entry) => entry.id !== nextEntry.id),
  ].slice(0, MAX_ANS_REGISTRATION_ACTIVITY_ITEMS)

  writeAnsRegistrationActivity(nextEntries)

  return nextEntries
}

export function upsertTrackedAnsDomain(
  domain: string,
  source: TrackedAnsDomainSource,
  walletAddress?: Address
) {
  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedDomain) {
    return []
  }

  const nextEntry: TrackedAnsDomain = {
    domain: normalizedDomain,
    source,
    walletAddress: walletAddress ?? null,
    lastTouchedAt: Date.now(),
  }

  const nextDomains = [
    nextEntry,
    ...readTrackedAnsDomains().filter((entry) => entry.domain !== normalizedDomain),
  ].slice(0, ANS_MAX_TRACKED_DOMAINS)

  writeTrackedAnsDomains(nextDomains)

  return nextDomains
}

export function removeTrackedAnsDomain(domain: string) {
  const normalizedDomain = domain.trim().toLowerCase()
  const nextDomains = readTrackedAnsDomains().filter(
    (entry) => entry.domain !== normalizedDomain
  )

  writeTrackedAnsDomains(nextDomains)

  return nextDomains
}

function isTrackedDomain(value: unknown): value is TrackedAnsDomain {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    typeof record.domain === "string" &&
    typeof record.lastTouchedAt === "number" &&
    typeof record.source === "string" &&
    (typeof record.walletAddress === "string" || record.walletAddress === null)
  )
}

function isAnsRegistrationActivityRecord(
  value: unknown
): value is AnsRegistrationActivityRecord {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    typeof record.id === "string" &&
    typeof record.domain === "string" &&
    typeof record.amount === "string" &&
    typeof record.durationYears === "number" &&
    typeof record.timestampMs === "number" &&
    (typeof record.txHash === "string" || record.txHash === null) &&
    (typeof record.walletAddress === "string" || record.walletAddress === null)
  )
}