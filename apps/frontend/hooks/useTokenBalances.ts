"use client";

import { useReadContracts } from "wagmi";

import { ERC20_ABI } from "@/constants/erc20";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { activeArcChain } from "@/lib/wagmi";
import { TOKEN_OPTIONS, type TokenSymbol } from "@/lib/wizpay";

interface UseTokenBalancesOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
}

/**
 * Fetches ERC-20 balances for all supported tokens (USDC, EURC)
 * for the connected external wallet via multicall on Arc Mainnet.
 */
export function useTokenBalances({
  enabled = true,
  refetchInterval = 30_000,
}: UseTokenBalancesOptions = {}) {
  const { walletAddress } = useActiveWalletAddress();

  const contracts = TOKEN_OPTIONS.map((token) => ({
    address: token.address,
    abi: ERC20_ABI,
    chainId: activeArcChain.id,
    functionName: "balanceOf" as const,
    args: walletAddress ? [walletAddress] : undefined,
  }));

  const { data, isLoading, isError, error, refetch } = useReadContracts({
    contracts: enabled && walletAddress ? contracts : [],
    query: {
      enabled: enabled && Boolean(walletAddress),
      refetchInterval,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
    },
  });

  const balances: Record<TokenSymbol, bigint> = { USDC: 0n, EURC: 0n };

  if (data) {
    TOKEN_OPTIONS.forEach((token, index) => {
      const result = data[index];
      if (result?.status === "success" && typeof result.result === "bigint") {
        balances[token.symbol] = result.result;
      }
    });
  }

  return {
    balances,
    error,
    isError,
    isLoading,
    refetch,
    source: "external" as const,
  };
}
