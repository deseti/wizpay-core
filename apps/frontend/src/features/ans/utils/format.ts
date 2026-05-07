import { formatUnits } from "viem"

export function formatUsdcAmount(value: bigint | null | undefined) {
  if (value == null) {
    return "0.00 USDC"
  }

  const numeric = Number(formatUnits(value, 6))

  return `${numeric.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDC`
}

export function formatTimestamp(value: bigint | number | null | undefined) {
  if (value == null) {
    return "Not registered"
  }

  const timestampSeconds = typeof value === "bigint" ? Number(value) : value
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return "Not registered"
  }

  return new Date(timestampSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function formatPromoWindow(startsAt: number, endsAt: number) {
  if (!startsAt && !endsAt) {
    return "Always on while enabled"
  }

  const startLabel = startsAt ? formatTimestamp(startsAt) : "immediately"
  const endLabel = endsAt ? formatTimestamp(endsAt) : "until disabled"

  return `${startLabel} -> ${endLabel}`
}

export function formatRelativeYears(years: number) {
  return `${years} year${years === 1 ? "" : "s"}`
}

export function formatDomainStatus(status: "available" | "registered" | "grace-period") {
  if (status === "available") {
    return "Available"
  }

  if (status === "grace-period") {
    return "Expired / Grace Period"
  }

  return "Registered"
}