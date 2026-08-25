import { getAddress, isAddress, isAddressEqual, type Address } from "viem";

export type CanonicalAppWalletResult =
  | { address: Address; mismatch: false }
  | { address: null; mismatch: true }
  | { address: null; mismatch: false };

export function resolveCanonicalAppWalletEvmAddress(
  ...candidates: Array<string | null | undefined>
): CanonicalAppWalletResult {
  const provided = candidates.filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  if (provided.some((candidate) => !isAddress(candidate))) {
    return { address: null, mismatch: true };
  }
  const addresses = provided.map((candidate) => getAddress(candidate));

  if (!addresses.length) return { address: null, mismatch: false };

  const [canonical, ...rest] = addresses;
  if (rest.some((address) => !isAddressEqual(address, canonical))) {
    return { address: null, mismatch: true };
  }

  return { address: canonical, mismatch: false };
}
