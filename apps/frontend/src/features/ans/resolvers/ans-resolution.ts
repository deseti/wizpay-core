import { zeroAddress, type Address, type PublicClient } from "viem"

import {
  ANS_ARC_REGISTRY_ABI,
  ANS_NAMESPACE_CONTROLLER_ABI,
  ANS_NAMESPACE_REGISTRAR_ABI,
  ANS_PUBLIC_RESOLVER_ABI,
  ANS_ROOT_REGISTRY_ABI,
} from "../contracts/abis"
import { ANS_GRACE_PERIOD_SECONDS, ANS_SECONDS_PER_YEAR } from "../pricing/constants"
import type {
  AnsContractsConfig,
  AnsDomainLookup,
  AnsDomainTarget,
  AnsNamespaceKey,
  AnsNamespaceSnapshot,
} from "../types/ans"
import { buildAnsNode, buildAnsTokenId } from "../utils/domain"

function readAddress(value: unknown): Address | null {
  if (typeof value !== "string" || value === zeroAddress) {
    return null
  }

  return value as Address
}

export async function fetchAnsNamespaceSnapshot(
  publicClient: PublicClient,
  contracts: AnsContractsConfig,
  namespace: AnsNamespaceKey
): Promise<AnsNamespaceSnapshot> {
  const [defaultResolver, namespaceConfig, namespacePricing, namespacePromo] =
    await Promise.all([
      publicClient.readContract({
        address: contracts.rootRegistry,
        abi: ANS_ROOT_REGISTRY_ABI,
        functionName: "defaultResolver",
      }),
      publicClient.readContract({
        address: contracts.rootRegistry,
        abi: ANS_ROOT_REGISTRY_ABI,
        functionName: "namespaceConfig",
        args: [namespace],
      }),
      publicClient.readContract({
        address: contracts.rootRegistry,
        abi: ANS_ROOT_REGISTRY_ABI,
        functionName: "namespacePricing",
        args: [namespace],
      }),
      publicClient.readContract({
        address: contracts.rootRegistry,
        abi: ANS_ROOT_REGISTRY_ABI,
        functionName: "namespacePromo",
        args: [namespace],
      }),
    ])

  const [namespaceOwner, registrar, controller, vault, active, isGlobal, whitelisted, blacklisted] =
    namespaceConfig
  const [threeCharacterPrice, fourCharacterPrice, fivePlusCharacterPrice] =
    namespacePricing
  const [promoEnabled, promoDiscountBps, promoStartsAt, promoEndsAt] =
    namespacePromo

  return {
    key: namespace,
    label: contracts.namespaces[namespace].label,
    suffix: contracts.namespaces[namespace].suffix,
    namespaceOwner,
    registrar,
    controller,
    vault,
    defaultResolver,
    active,
    isGlobal,
    whitelisted,
    blacklisted,
    threeCharacterPrice,
    fourCharacterPrice,
    fivePlusCharacterPrice,
    promoEnabled,
    promoDiscountBps,
    promoStartsAt: Number(promoStartsAt),
    promoEndsAt: Number(promoEndsAt),
  }
}

export async function fetchAnsDomainLookup(
  publicClient: PublicClient,
  contracts: AnsContractsConfig,
  target: AnsDomainTarget,
  durationYears: number,
  namespaceSnapshot: AnsNamespaceSnapshot
): Promise<AnsDomainLookup> {
  const durationSeconds = BigInt(durationYears) * ANS_SECONDS_PER_YEAR
  const tokenId = buildAnsTokenId(target.label)
  const node = buildAnsNode(target.domain)

  const [available, rentPrice, expiresRaw, resolverRaw] = await Promise.all([
    publicClient.readContract({
      address: namespaceSnapshot.controller,
      abi: ANS_NAMESPACE_CONTROLLER_ABI,
      functionName: "available",
      args: [target.label],
    }),
    publicClient.readContract({
      address: namespaceSnapshot.controller,
      abi: ANS_NAMESPACE_CONTROLLER_ABI,
      functionName: "rentPrice",
      args: [target.label, durationSeconds],
    }),
    publicClient.readContract({
      address: namespaceSnapshot.registrar,
      abi: ANS_NAMESPACE_REGISTRAR_ABI,
      functionName: "nameExpires",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: contracts.registry,
      abi: ANS_ARC_REGISTRY_ABI,
      functionName: "resolver",
      args: [node],
    }),
  ])

  let ownerAddress: Address | null = null
  try {
    ownerAddress = await publicClient.readContract({
      address: namespaceSnapshot.registrar,
      abi: ANS_NAMESPACE_REGISTRAR_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    })
  } catch {
    ownerAddress = null
  }

  let resolvedAddress: Address | null = null
  const resolverAddress = readAddress(resolverRaw)
  if (resolverAddress) {
    try {
      resolvedAddress = readAddress(
        await publicClient.readContract({
          address: resolverAddress,
          abi: ANS_PUBLIC_RESOLVER_ABI,
          functionName: "addr",
          args: [node],
        })
      )
    } catch {
      resolvedAddress = null
    }
  }

  const expiresAt = expiresRaw > 0n ? expiresRaw : null
  const now = BigInt(Math.floor(Date.now() / 1000))
  const isExpired = expiresAt !== null && expiresAt <= now
  const inGracePeriod = expiresAt !== null && isExpired && !available
  const graceEndsAt = expiresAt !== null ? expiresAt + ANS_GRACE_PERIOD_SECONDS : null
  const annualBasePrice =
    target.labelLength === 3
      ? namespaceSnapshot.threeCharacterPrice
      : target.labelLength === 4
        ? namespaceSnapshot.fourCharacterPrice
        : namespaceSnapshot.fivePlusCharacterPrice

  return {
    target,
    tokenId,
    node,
    durationYears,
    durationSeconds,
    annualBasePrice,
    rentPrice,
    available,
    ownerAddress,
    expiresAt,
    isExpired,
    inGracePeriod,
    graceEndsAt,
    resolverAddress,
    resolvedAddress,
    status: available ? "available" : inGracePeriod ? "grace-period" : "registered",
    namespaceSnapshot,
  }
}