import { getArcMainnetUniswapV4Readiness } from "@wizpay/arc-network";
import {
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_POOL_KEY,
  deriveMainnetUniswapV4PoolId,
} from "./mainnet-uniswap-v4-protocol";

export const ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE =
  "Arc Mainnet USDC/EURC direct-swap evidence is candidate-only. Swaps remain unavailable until pool uniqueness, live liquidity, RPC, and execution-authorization gates pass.";

export function getMainnetUniswapV4UnavailableState() {
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
