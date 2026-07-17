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
import { runAnsRpcRead } from "../services/ans-rpc"

const ARC_MULTICALL3_ADDRESS =
  "0xca11bde05977b3631167028862be2a173976ca11" as Address

function readAddress(value: unknown): Address | null {
  if (typeof value !== "string" || value === zeroAddress) {
    return null
  }

  return value as Address
}

export function getAnsReadErrorMessage(error: unknown) {
  const shortMessage =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "shortMessage")
      : null
  const message = error instanceof Error ? error.message : ""
  const details =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "details")
      : null
  const rpcMessage = [shortMessage, message, details]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()

  if (
    rpcMessage.includes("request limit") ||
    rpcMessage.includes("rate limit") ||
    rpcMessage.includes("rpc request failed") ||
    rpcMessage.includes("http request failed") ||
    rpcMessage.includes("fetch failed") ||
    rpcMessage.includes("timed out")
  ) {
    return "Arc Testnet RPC is temporarily busy. Wait a moment, then load the ANS quote again."
  }

  return "Unable to read the current ANS contract state. Please try again."
}

export async function fetchAnsNamespaceSnapshot(
  publicClient: PublicClient,
  contracts: AnsContractsConfig,
  namespace: AnsNamespaceKey
): Promise<AnsNamespaceSnapshot> {
  const [defaultResolver, namespaceConfig, namespacePricing, namespacePromo] =
    await runAnsRpcRead(
      `namespace:${contracts.chainId}:${contracts.rootRegistry.toLowerCase()}:${namespace}`,
      () =>
        publicClient.multicall({
          allowFailure: false,
          contracts: [
            {
              address: contracts.rootRegistry,
              abi: ANS_ROOT_REGISTRY_ABI,
              functionName: "defaultResolver",
            },
            {
              address: contracts.rootRegistry,
              abi: ANS_ROOT_REGISTRY_ABI,
              functionName: "namespaceConfig",
              args: [namespace],
            },
            {
              address: contracts.rootRegistry,
              abi: ANS_ROOT_REGISTRY_ABI,
              functionName: "namespacePricing",
              args: [namespace],
            },
            {
              address: contracts.rootRegistry,
              abi: ANS_ROOT_REGISTRY_ABI,
              functionName: "namespacePromo",
              args: [namespace],
            },
          ],
          multicallAddress: ARC_MULTICALL3_ADDRESS,
        })
    )

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

  const lookupKey = `${contracts.chainId}:${namespaceSnapshot.controller.toLowerCase()}:${target.domain}:${durationSeconds}`
  const [available, rentPrice] = await runAnsRpcRead(
    `lookup:${lookupKey}`,
    () =>
      publicClient.multicall({
        allowFailure: false,
        contracts: [
          {
            address: namespaceSnapshot.controller,
            abi: ANS_NAMESPACE_CONTROLLER_ABI,
            functionName: "available",
            args: [target.label],
          },
          {
            address: namespaceSnapshot.controller,
            abi: ANS_NAMESPACE_CONTROLLER_ABI,
            functionName: "rentPrice",
            args: [target.label, durationSeconds],
          },
        ],
        multicallAddress: ARC_MULTICALL3_ADDRESS,
      })
  )

  let expiresRaw = 0n
  let resolverRaw: Address = zeroAddress
  let ownerAddress: Address | null = null
  if (!available) {
    const [expiresResult, resolverResult, ownerResult] =
      await runAnsRpcRead(`details:${lookupKey}`, () =>
        publicClient.multicall({
          allowFailure: true,
          contracts: [
            {
              address: namespaceSnapshot.registrar,
              abi: ANS_NAMESPACE_REGISTRAR_ABI,
              functionName: "nameExpires",
              args: [tokenId],
            },
            {
              address: contracts.registry,
              abi: ANS_ARC_REGISTRY_ABI,
              functionName: "resolver",
              args: [node],
            },
            {
              address: namespaceSnapshot.registrar,
              abi: ANS_NAMESPACE_REGISTRAR_ABI,
              functionName: "ownerOf",
              args: [tokenId],
            },
          ],
          multicallAddress: ARC_MULTICALL3_ADDRESS,
        })
      )

    if (expiresResult.status === "failure") {
      throw expiresResult.error
    }
    if (resolverResult.status === "failure") {
      throw resolverResult.error
    }

    expiresRaw = expiresResult.result
    resolverRaw = resolverResult.result
    ownerAddress =
      ownerResult.status === "success" ? ownerResult.result : null
  }

  let resolvedAddress: Address | null = null
  const resolverAddress = readAddress(resolverRaw)
  if (resolverAddress) {
    try {
      resolvedAddress = readAddress(
        await runAnsRpcRead(`resolved-address:${lookupKey}`, () =>
          publicClient.readContract({
            address: resolverAddress,
            abi: ANS_PUBLIC_RESOLVER_ABI,
            functionName: "addr",
            args: [node],
          })
        )
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
