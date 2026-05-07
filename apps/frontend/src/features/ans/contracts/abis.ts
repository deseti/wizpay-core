import type { Abi } from "viem"

export const ANS_ROOT_REGISTRY_ABI = [
  {
    type: "function",
    name: "defaultResolver",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "resolver", type: "address" }],
  },
  {
    type: "function",
    name: "namespaceConfig",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [
      { name: "namespaceOwner", type: "address" },
      { name: "registrar", type: "address" },
      { name: "controller", type: "address" },
      { name: "vault", type: "address" },
      { name: "active", type: "bool" },
      { name: "isGlobal", type: "bool" },
      { name: "whitelisted", type: "bool" },
      { name: "blacklisted", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "namespacePricing",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [
      { name: "threeCharacterPrice", type: "uint256" },
      { name: "fourCharacterPrice", type: "uint256" },
      { name: "fivePlusCharacterPrice", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "namespacePromo",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [
      { name: "enabled", type: "bool" },
      { name: "discountBps", type: "uint16" },
      { name: "startsAt", type: "uint64" },
      { name: "endsAt", type: "uint64" },
    ],
  },
] as const satisfies Abi

export const ANS_NAMESPACE_CONTROLLER_ABI = [
  {
    type: "function",
    name: "available",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "isAvailable", type: "bool" }],
  },
  {
    type: "function",
    name: "rentPrice",
    stateMutability: "view",
    inputs: [
      { name: "label", type: "string" },
      { name: "duration", type: "uint256" },
    ],
    outputs: [{ name: "price", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenIdForLabel",
    stateMutability: "pure",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "ownerAddress", type: "address" },
      { name: "duration", type: "uint256" },
      { name: "resolverAddress", type: "address" },
      { name: "resolvedAddress", type: "address" },
      { name: "textKeys", type: "string[]" },
      { name: "textValues", type: "string[]" },
    ],
    outputs: [
      { name: "node", type: "bytes32" },
      { name: "expires", type: "uint256" },
    ],
  },
] as const satisfies Abi

export const ANS_NAMESPACE_REGISTRAR_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "ownerAddress", type: "address" }],
  },
  {
    type: "function",
    name: "nameExpires",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "expires", type: "uint256" }],
  },
] as const satisfies Abi

export const ANS_ARC_REGISTRY_ABI = [
  {
    type: "function",
    name: "resolver",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "resolverAddress", type: "address" }],
  },
] as const satisfies Abi

export const ANS_PUBLIC_RESOLVER_ABI = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "resolvedAddress", type: "address" }],
  },
] as const satisfies Abi