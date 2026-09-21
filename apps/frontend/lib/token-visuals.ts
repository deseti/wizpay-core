import { getAddress, isAddress, type Address } from "viem";

import { ARC_MAINNET_CHAIN_ID, SUPPORTED_TOKENS, type TokenSymbol } from "@/lib/wizpay";

export type TokenVisual = {
  chainId: number;
  canonicalAddress: Address;
  symbol: TokenSymbol;
  displayName: string;
  decimals: number;
  iconPath: string;
};

const visuals = Object.freeze(
  Object.values(SUPPORTED_TOKENS).map((token) => ({
    chainId: ARC_MAINNET_CHAIN_ID,
    canonicalAddress: token.address,
    symbol: token.symbol,
    displayName: token.name,
    decimals: token.decimals,
    iconPath: token.symbol === "USDC" ? "/tokens/usdc.png" : "/tokens/eurc.png",
  })) satisfies TokenVisual[],
);

const byIdentity = new Map(visuals.map((visual) => [`${visual.chainId}:${visual.canonicalAddress.toLowerCase()}`, visual]));

export function getTokenVisual(chainId: number, address: string): TokenVisual | null {
  if (!isAddress(address)) return null;
  return byIdentity.get(`${chainId}:${getAddress(address).toLowerCase()}`) ?? null;
}

export function getTokenVisualForSymbol(symbol: TokenSymbol, chainId = ARC_MAINNET_CHAIN_ID) {
  const token = SUPPORTED_TOKENS[symbol];
  return token ? getTokenVisual(chainId, token.address) : null;
}

export { visuals as TOKEN_VISUALS };
