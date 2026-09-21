import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";

export const WIZPAY_ADDRESS = ACTIVE_ARC_NETWORK.contracts.wizpay?.address;
export const WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS =
  ACTIVE_ARC_NETWORK.contracts.wizpaySwapExecutorMainnet?.address;
export const WIZPAY_HISTORY_ADDRESSES = [WIZPAY_ADDRESS] as const;
export const WIZPAY_HISTORY_FROM_BLOCK = 35_790_000n;

export const USDC_ADDRESS = ACTIVE_ARC_NETWORK.tokens.USDC?.address;
export const EURC_ADDRESS = ACTIVE_ARC_NETWORK.tokens.EURC?.address;
export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
