/**
 * Shared FX types and interfaces for the StableFX Migration.
 *
 * These types model the Circle StableFX RFQ flow, settlement lifecycle,
 * routing guard state, and LP wind-down process.
 */

/**
 * Request parameters for obtaining an RFQ quote from Circle StableFX.
 * Either fromAmount or toAmount must be specified (mutually exclusive).
 */
export interface QuoteRequest {
  fromCurrency: string;
  toCurrency: string;
  fromAmount?: string;
  toAmount?: string;
  tenor: 'instant' | 'hourly' | 'daily';
}

/**
 * Binding price quote returned by Circle StableFX containing rate,
 * expiry, quote identifier, and settlement parameters.
 */
export interface RfqQuote {
  quoteId: string;
  rate: string;
  fromAmount: string;
  toAmount: string;
  fee: string;
  expiresAt: string;
  tenor: string;
}

/**
 * Response from creating a trade against an accepted quote.
 */
export interface TradeResponse {
  tradeId: string;
  status: TradeStatusValue;
  quoteId: string;
  fromAmount: string;
  toAmount: string;
}

/**
 * All possible trade status values in the Circle StableFX settlement lifecycle.
 */
export type TradeStatusValue =
  | 'confirmed'
  | 'pending_settlement'
  | 'taker_funded'
  | 'maker_funded'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'breached';

/**
 * Payload for an FX operation submitted to the orchestrator.
 * minOutput is REQUIRED for all cross-currency operations.
 */
export interface FxOperationPayload {
  sourceToken: string;
  destinationToken: string;
  amount: string;
  minOutput: string;
  recipient: string;
  tenor?: 'instant' | 'hourly' | 'daily';
}

/**
 * Feature flag routing state including circuit breaker status.
 */
export interface FxRoutingState {
  mode: 'legacy' | 'new';
  updatedAt: string;
  updatedBy: string;
  recentOutcomes: Array<{
    timestamp: string;
    success: boolean;
    operationId: string;
  }>;
  circuitOpen: boolean;
}

/**
 * Record of a completed settlement with both quoted and confirmed amounts.
 * Only confirmed amounts are used for balance accounting and fund release.
 */
export interface SettlementRecord {
  taskId: string;
  tradeId: string;
  quoteId: string;
  quotedRate: string;
  quotedFromAmount: string;
  quotedToAmount: string;
  confirmedInputDebited: string;
  confirmedOutputCredited: string;
  confirmedFeesCharged: string;
  settlementTimestamp: string;
  deviationPercent: string;
  alertTriggered: boolean;
}

/**
 * Result of settlement output validation against minimum thresholds.
 */
export interface ValidationResult {
  accepted: boolean;
  deviationPercent?: number;
  alertRequired?: boolean;
  reason?: string;
}

/**
 * State of the LP wind-down process for the deprecated StableFXAdapter_V2.
 */
export interface WindDownState {
  initiated: boolean;
  initiatedAt?: string;
  withdrawalWindowEnd?: string;
  depositors: Array<{
    address: string;
    token: string;
    shares: string;
    proRataAmount: string;
    withdrawn: boolean;
    failureReason?: string;
  }>;
  totalSupplyAtStart: string;
  currentTotalSupply: string;
  complete: boolean;
}

/**
 * Registry of supported token pairs for Circle StableFX RFQ.
 * Requests for undocumented pairs are rejected without calling the API.
 */
export interface TokenPairRegistry {
  pairs: Array<{
    fromCurrency: string;
    toCurrency: string;
    minAmount: string;
    enabled: boolean;
  }>;
  lastUpdated: string;
}
