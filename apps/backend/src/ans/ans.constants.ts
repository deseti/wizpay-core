import type { Abi } from 'viem';

export const DEFAULT_ARC_RPC_URL = 'https://rpc.testnet.arc.network';
export const DEFAULT_ARC_REGISTRY_ADDRESS =
  '0x3885E01e3439fc094B083E834Fb4cD36211BEd84';

/**
 * Minimal Arc registry ABI required for ANS resolution.
 */
export const ARC_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'resolver',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: 'resolverAddress', type: 'address' }],
  },
] as const satisfies Abi;

/**
 * Minimal public resolver ABI required for ANS address and metadata lookups.
 */
export const PUBLIC_RESOLVER_ABI = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: 'resolvedAddress', type: 'address' }],
  },
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ name: 'value', type: 'string' }],
  },
] as const satisfies Abi;

/**
 * Configuration key for the Arc RPC endpoint.
 */
export const ARC_RPC_URL_CONFIG_KEY = 'ARC_RPC_URL';

/**
 * Optional fallback keys because the monorepo has historically used shared RPC env names.
 */
export const RPC_URL_CONFIG_KEY = 'RPC_URL';
export const NEXT_PUBLIC_ARC_TESTNET_RPC_URL_CONFIG_KEY =
  'NEXT_PUBLIC_ARC_TESTNET_RPC_URL';
export const NEXT_PUBLIC_RPC_URL_CONFIG_KEY = 'NEXT_PUBLIC_RPC_URL';

/**
 * Configuration key for the deployed Arc registry address.
 */
export const ARC_REGISTRY_ADDRESS_CONFIG_KEY = 'ARC_REGISTRY_ADDRESS';

/**
 * Optional fallback key because frontend and backend share the monorepo root env.
 */
export const NEXT_PUBLIC_ANS_REGISTRY_CONFIG_KEY = 'NEXT_PUBLIC_ANS_REGISTRY';