import { keccak256, namehash, toBytes } from "viem"

import type {
  AnsDomainTarget,
  AnsNamespaceKey,
  ParsedAnsSearchInput,
} from "../types/ans"

function isSupportedNamespace(value: string): value is AnsNamespaceKey {
  return value === "arc" || value === "wizpay"
}

export function buildAnsDomain(label: string, namespace: AnsNamespaceKey) {
  return `${label}.${namespace}`
}

export function buildAnsNode(domain: string) {
  return namehash(domain)
}

export function buildAnsTokenId(label: string) {
  return BigInt(keccak256(toBytes(label)))
}

export function validateAnsLabel(label: string) {
  if (label.length < 3) {
    return "Labels must be at least 3 characters long."
  }

  if (label.startsWith("-") || label.endsWith("-")) {
    return "Labels cannot start or end with a hyphen."
  }

  if (label.includes(".")) {
    return "Only exact second-level names are supported right now."
  }

  if (!/^[a-z0-9-]+$/.test(label)) {
    return "Use lowercase letters, numbers, and hyphens only."
  }

  return null
}

export function parseAnsSearchInput(
  input: string,
  defaultNamespace: AnsNamespaceKey
): ParsedAnsSearchInput {
  const normalizedInput = input.trim().toLowerCase().replace(/^\.+|\.+$/g, "")

  if (!normalizedInput) {
    return {
      normalizedInput,
      error: "Enter an exact ANS label or domain.",
      target: null,
    }
  }

  const parts = normalizedInput.split(".").filter(Boolean)

  if (parts.length > 2) {
    return {
      normalizedInput,
      error: "Only exact second-level names are supported. Subdomains need indexing and are out of scope.",
      target: null,
    }
  }

  const namespace = parts.length === 2 ? parts[1] : defaultNamespace
  if (!isSupportedNamespace(namespace)) {
    return {
      normalizedInput,
      error: "Only .arc and .wizpay are supported in this release.",
      target: null,
    }
  }

  const label = parts[0] ?? ""
  const labelError = validateAnsLabel(label)
  if (labelError) {
    return {
      normalizedInput,
      error: labelError,
      target: null,
    }
  }

  const target: AnsDomainTarget = {
    label,
    namespace,
    domain: buildAnsDomain(label, namespace),
    labelLength: label.length,
  }

  return {
    normalizedInput,
    error: null,
    target,
  }
}