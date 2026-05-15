export const OFFICIAL_SWAP_ALLOWED_CHAIN = 'ARC-TESTNET' as const;
export const OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR =
  'circle-agent-wallet' as const;

export const OFFICIAL_SWAP_ERROR_CODES = {
  CIRCLE_CLI_EXECUTION_FAILED: 'CIRCLE_CLI_EXECUTION_FAILED',
  CIRCLE_CLI_INVALID_JSON: 'CIRCLE_CLI_INVALID_JSON',
  CIRCLE_CLI_NOT_AVAILABLE: 'CIRCLE_CLI_NOT_AVAILABLE',
  CIRCLE_CLI_UNEXPECTED_RESPONSE: 'CIRCLE_CLI_UNEXPECTED_RESPONSE',
  DISABLED: 'OFFICIAL_SWAP_DISABLED',
  EXECUTOR_UNAVAILABLE: 'OFFICIAL_SWAP_EXECUTOR_UNAVAILABLE',
  MIN_OUTPUT_REQUIRED: 'MIN_OUTPUT_REQUIRED',
  NOT_IMPLEMENTED: 'OFFICIAL_SWAP_NOT_IMPLEMENTED',
  TESTNET_CLI_DISABLED: 'OFFICIAL_SWAP_TESTNET_CLI_DISABLED',
  UNSUPPORTED_CHAIN: 'UNSUPPORTED_CHAIN',
  WALLET_ADDRESS_REQUIRED: 'WALLET_ADDRESS_REQUIRED',
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

export interface OfficialSwapQuoteResponse {
  status: 'QUOTE_READY';
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  chain: OfficialSwapChain;
  estimatedOutput: string;
  minOutput: string;
  estimatedOutputRaw?: string;
  minOutputRaw?: string;
  fees?: unknown;
  message?: string;
}

export interface OfficialSwapOperation {
  state?: string;
  txHash?: string;
  operation?: string;
  abiFunctionSignature?: string;
  contractAddress?: string;
}

export interface OfficialSwapExecuteResponse {
  operationId: string;
  status: 'COMPLETE' | 'IN_PROGRESS' | 'FAILED';
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  minOutput: string;
  chain: OfficialSwapChain;
  txHashes: string[];
  operations: OfficialSwapOperation[];
  message?: string;
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
  ): Promise<OfficialSwapQuoteResponse>;
  execute(
    request: OfficialSwapExecuteRequest,
  ): Promise<OfficialSwapExecuteResponse>;
}
