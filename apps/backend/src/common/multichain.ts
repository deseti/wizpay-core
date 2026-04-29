const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const EVM_TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

export type CanonicalBridgeChain =
  | 'arc_testnet'
  | 'eth_sepolia'
  | 'solana_devnet';

export function isEvmAddress(value: unknown): value is string {
  return typeof value === 'string' && EVM_ADDRESS_REGEX.test(value.trim());
}

export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const candidate = value.trim();

  // Solana pubkeys are base58 and typically 32-44 chars.
  return (
    candidate.length >= 32 &&
    candidate.length <= 44 &&
    BASE58_REGEX.test(candidate)
  );
}

export function isEvmTxHash(value: unknown): value is string {
  return typeof value === 'string' && EVM_TX_HASH_REGEX.test(value.trim());
}

export function isSolanaSignature(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const candidate = value.trim();

  // Signatures are base58 and generally around 64-88 chars.
  return (
    candidate.length >= 64 &&
    candidate.length <= 88 &&
    BASE58_REGEX.test(candidate)
  );
}

export function normalizeChainTxId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const candidate = value.trim();

  if (!candidate) {
    return null;
  }

  if (isEvmTxHash(candidate) || isSolanaSignature(candidate)) {
    return candidate;
  }

  return null;
}

export function normalizeBridgeChain(value: unknown): CanonicalBridgeChain | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[-\s]/g, '_');

  switch (normalized) {
    case 'arc_testnet':
      return 'arc_testnet';
    case 'eth_sepolia':
    case 'ethereum_sepolia':
      return 'eth_sepolia';
    case 'solana_devnet':
      return 'solana_devnet';
    default:
      return null;
  }
}
