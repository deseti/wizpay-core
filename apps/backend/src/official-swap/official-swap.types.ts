export const OFFICIAL_SWAP_ALLOWED_CHAIN = 'ARC-TESTNET' as const;
export const OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR =
  'circle-agent-wallet' as const;

export const OFFICIAL_SWAP_ERROR_CODES = {
  DISABLED: 'OFFICIAL_SWAP_DISABLED',
  EXECUTOR_UNAVAILABLE: 'OFFICIAL_SWAP_EXECUTOR_UNAVAILABLE',
  MIN_OUTPUT_REQUIRED: 'MIN_OUTPUT_REQUIRED',
  NOT_IMPLEMENTED: 'OFFICIAL_SWAP_NOT_IMPLEMENTED',
  UNSUPPORTED_CHAIN: 'UNSUPPORTED_CHAIN',
} as const;

export type OfficialSwapChain = typeof OFFICIAL_SWAP_ALLOWED_CHAIN;
export type OfficialSwapExecutorConfigured =
  | 'disabled'
  | typeof OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR
  | 'unsupported';

export interface OfficialSwapQuoteRequest {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  chain: string;
}

export interface OfficialSwapExecuteRequest extends OfficialSwapQuoteRequest {
  minOutput: string;
  walletAddress?: string;
}

export interface OfficialSwapPlaceholderResponse {
  operationId?: string;
  status: 'NOT_IMPLEMENTED';
  chain: OfficialSwapChain;
  message: string;
}

export interface OfficialSwapExecutor {
  quote(
    request: OfficialSwapQuoteRequest,
  ): Promise<OfficialSwapPlaceholderResponse>;
  execute(
    request: OfficialSwapExecuteRequest,
  ): Promise<OfficialSwapPlaceholderResponse>;
}
