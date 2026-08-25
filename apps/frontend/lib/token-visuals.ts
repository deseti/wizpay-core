import { getAddress, isAddress, type Address } from "viem";

import { ARC_TESTNET_CHAIN_ID, SUPPORTED_TOKENS, type TokenSymbol } from "@/lib/wizpay";

export type TokenVisual = {
  chainId: number;
  canonicalAddress: Address;
  symbol: TokenSymbol;
  displayName: string;
  decimals: number;
  iconPath: string;
};

const visuals = Object.freeze([
  {
    chainId: ARC_TESTNET_CHAIN_ID,
    canonicalAddress: SUPPORTED_TOKENS.USDC.address,
    symbol: "USDC",
    displayName: SUPPORTED_TOKENS.USDC.name,
    decimals: 6,
    iconPath: "/tokens/usdc.png",
  },
  {
    chainId: ARC_TESTNET_CHAIN_ID,
    canonicalAddress: SUPPORTED_TOKENS.EURC.address,
    symbol: "EURC",
    displayName: SUPPORTED_TOKENS.EURC.name,
    decimals: 6,
    iconPath: "/tokens/eurc.png",
  },
] satisfies TokenVisual[]);

const byIdentity = new Map(visuals.map((visual) => [`${visual.chainId}:${visual.canonicalAddress.toLowerCase()}`, visual]));

export function getTokenVisual(chainId: number, address: string): TokenVisual | null {
  if (!isAddress(address)) return null;
  return byIdentity.get(`${chainId}:${getAddress(address).toLowerCase()}`) ?? null;
}

export function getTokenVisualForSymbol(symbol: TokenSymbol, chainId = ARC_TESTNET_CHAIN_ID) {
  const token = SUPPORTED_TOKENS[symbol];
  return getTokenVisual(chainId, token.address);
}

export { visuals as TOKEN_VISUALS };
