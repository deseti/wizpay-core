import { useEffect, useState } from "react";

import { getArcMainnetUniswapV4Readiness } from "@wizpay/arc-network";
import {
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_POOL_KEY,
  deriveMainnetUniswapV4PoolId,
} from "./mainnet-uniswap-v4-protocol";
import { fetchMainnetSwapReadiness } from "@/lib/user-swap-service";

export const ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE =
  "Arc Mainnet USDC/EURC direct-swap evidence is candidate-only. Swaps remain unavailable until pool uniqueness, live liquidity, RPC, and execution-authorization gates pass.";

export type MainnetUniswapV4Gate = Readonly<{
  available: boolean;
  executable: boolean;
  poolIdentityStatus: string;
  message: string | null;
  blockers: readonly string[];
  candidatePool: Readonly<{
    poolKey: typeof ARC_MAINNET_UNISWAP_V4_POOL_KEY;
    poolId: typeof ARC_MAINNET_UNISWAP_V4_POOL_ID;
    derivedPoolId: string;
  }>;
  readiness: ReturnType<typeof getArcMainnetUniswapV4Readiness>;
}>;

export function getMainnetUniswapV4UnavailableState(): MainnetUniswapV4Gate {
  const readiness = getArcMainnetUniswapV4Readiness();
  return Object.freeze({
    available: false as const,
    executable: false as const,
    poolIdentityStatus: "candidate-unverified" as const,
    message: ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE,
    blockers: readiness.blockers,
    candidatePool: Object.freeze({
      poolKey: ARC_MAINNET_UNISWAP_V4_POOL_KEY,
      poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
      derivedPoolId: deriveMainnetUniswapV4PoolId(),
    }),
    readiness,
  });
}

/**
 * Single authoritative readiness state: the backend live two-RPC quorum over
 * pool/executor state. Starts fail-closed (static unavailable) and upgrades
 * only when the backend confirms executable. No static flag can ever mark
 * the route executable.
 */
export function useMainnetUniswapV4Gate(): MainnetUniswapV4Gate {
  const [gate, setGate] = useState<MainnetUniswapV4Gate>(() =>
    getMainnetUniswapV4UnavailableState(),
  );

  useEffect(() => {
    let cancelled = false;
    void fetchMainnetSwapReadiness()
      .then((response) => {
        if (cancelled) return;
        if (
          response.available === true &&
          response.executable === true &&
          typeof response.poolIdentityStatus === "string" &&
          Array.isArray(response.blockers) &&
          response.blockers.length === 0
        ) {
          const base = getMainnetUniswapV4UnavailableState();
          setGate(
            Object.freeze({
              available: true as const,
              executable: true as const,
              poolIdentityStatus: response.poolIdentityStatus,
              message: null,
              blockers: Object.freeze([]) as readonly string[],
              candidatePool: base.candidatePool,
              readiness: base.readiness,
            }),
          );
        }
      })
      .catch(() => {
        // Stay fail-closed on any readiness fetch failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return gate;
}
