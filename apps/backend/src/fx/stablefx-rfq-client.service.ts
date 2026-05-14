import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RATE_ANOMALY_THRESHOLD_PERCENT } from './fx.constants';
import {
  QuoteRequest,
  RfqQuote,
  TradeResponse,
  TradeStatusValue,
  TokenPairRegistry,
} from './fx.types';

/**
 * Error codes for categorizing StableFX RFQ failures.
 * No fallback to internal pricing on any failure.
 */
export type RfqErrorCode =
  | 'network_timeout'
  | 'api_error'
  | 'auth_entitlement_blocked'
  | 'invalid_response';

/**
 * Structured error thrown by StableFXRfqClient on any failure.
 */
export class StableFxRfqError extends Error {
  constructor(
    public readonly code: RfqErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StableFxRfqError';
  }
}

/**
 * Trade status response from Circle StableFX API.
 */
export interface TradeStatus {
  tradeId: string;
  status: TradeStatusValue;
  fromAmount: string;
  toAmount: string;
  settledAt?: string;
}

/**
 * Token pair entry for supported pairs registry.
 */
export interface TokenPair {
  fromCurrency: string;
  toCurrency: string;
  minAmount: string;
  enabled: boolean;
}

/**
 * Internal record for rate anomaly detection.
 */
interface QuoteHistoryEntry {
  rate: number;
  timestamp: number;
}

/** Request timeout in milliseconds (30 seconds). */
const REQUEST_TIMEOUT_MS = 30_000;

/** Rate anomaly window in milliseconds (60 seconds). */
const RATE_ANOMALY_WINDOW_MS = 60_000;

/**
 * StableFXRfqClient is the NestJS injectable service responsible for all
 * communication with the Circle StableFX API.
 *
 * Responsibilities:
 * - Request binding quotes from Circle StableFX POST /quotes
 * - Validate quote responses (non-zero rate, future expiry, non-empty quoteId)
 * - Create trades via POST /trades
 * - Poll trade status via GET /trades/{tradeId}
 * - Enforce supported pair registry (reject undocumented pairs without API call)
 * - Detect rate anomalies (>5% deviation within 60s for same pair)
 * - Categorize all errors explicitly (network_timeout, api_error, invalid_response)
 * - No fallback to internal pricing on any failure
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */
@Injectable()
export class StableFXRfqClient {
  private readonly logger = new Logger(StableFXRfqClient.name);

  /**
   * In-memory cache of recent quotes per pair for rate anomaly detection.
   * Key format: `${fromCurrency}/${toCurrency}`
   */
  private readonly quoteHistory = new Map<string, QuoteHistoryEntry>();

  /**
   * Configured token pair registry. Loaded from config on first access.
   */
  private tokenPairRegistry: TokenPairRegistry | undefined;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Requests a binding quote from the Circle StableFX API.
   *
   * Flow:
   * 1. Validate the pair is supported (reject unsupported without API call)
   * 2. Call Circle StableFX API POST /quotes with 30s timeout
   * 3. Validate response: rate > 0, expiresAt >= now + 10s, quoteId non-empty
   * 4. Log quote to task log
   * 5. Check for rate anomaly (>5% deviation from previous quote for same pair within 60s)
   * 6. On any failure: explicit error code, NO fallback
   *
   * @param params - Quote request parameters
   * @returns Validated RFQ quote
   * @throws StableFxRfqError with categorized error code on any failure
   */
  async requestQuote(params: QuoteRequest): Promise<RfqQuote> {
    // Step 1: Enforce supported pair
    this.enforceSupportedPair(params.fromCurrency, params.toCurrency);

    const requestTimestamp = new Date().toISOString();

    // Step 2: Call Circle StableFX API
    const response = await this.callApi<RfqQuote>('POST', '/quotes', {
      fromCurrency: params.fromCurrency,
      toCurrency: params.toCurrency,
      fromAmount: params.fromAmount,
      toAmount: params.toAmount,
      tenor: params.tenor,
    });

    // Step 3: Validate response
    this.validateQuote(response);

    // Step 4: Log quote to task log
    this.logQuote(response, params, requestTimestamp);

    // Step 5: Rate anomaly detection
    this.detectRateAnomaly(params.fromCurrency, params.toCurrency, response);

    return response;
  }

  /**
   * Creates a trade against an accepted quote.
   *
   * @param quoteId - The quote identifier to execute
   * @param signature - User signature authorizing the trade
   * @returns Trade response with tradeId and status
   * @throws StableFxRfqError with categorized error code on any failure
   */
  async createTrade(
    quoteId: string,
    signature: string,
  ): Promise<TradeResponse> {
    if (!quoteId || !signature) {
      throw new StableFxRfqError(
        'invalid_response',
        'quoteId and signature are required to create a trade',
        { quoteId, hasSignature: !!signature },
      );
    }

    return this.callApi<TradeResponse>('POST', '/trades', {
      quoteId,
      signature,
    });
  }

  /**
   * Gets the current status of a trade.
   *
   * @param tradeId - The trade identifier to check
   * @returns Current trade status
   * @throws StableFxRfqError with categorized error code on any failure
   */
  async getTradeStatus(tradeId: string): Promise<TradeStatus> {
    if (!tradeId) {
      throw new StableFxRfqError(
        'invalid_response',
        'tradeId is required to get trade status',
        { tradeId },
      );
    }

    return this.callApi<TradeStatus>('GET', `/trades/${tradeId}`);
  }

  /**
   * Returns the configured token pair registry.
   * Pairs are loaded from configuration and represent the set of
   * token pairs supported by Circle StableFX.
   *
   * @returns Array of supported token pairs
   */
  async getSupportedPairs(): Promise<TokenPair[]> {
    const registry = this.getTokenPairRegistry();
    return registry.pairs.filter((p) => p.enabled);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Quote Validation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Validates an RFQ quote response.
   *
   * Acceptance criteria (all must hold):
   * - rate is non-zero (parsed as number > 0)
   * - expiresAt is at least 10 seconds in the future relative to server time
   * - quoteId is non-empty
   *
   * @throws StableFxRfqError with code 'invalid_response' if validation fails
   */
  validateQuote(quote: RfqQuote): void {
    const errors: string[] = [];

    // Validate rate is non-zero
    const rate = parseFloat(quote.rate);
    if (!quote.rate || isNaN(rate) || rate <= 0) {
      errors.push(`rate must be non-zero positive, got "${quote.rate}"`);
    }

    // Validate expiresAt is at least 10s in the future
    const now = Date.now();
    const expiresAtMs = Date.parse(quote.expiresAt);
    if (!quote.expiresAt || isNaN(expiresAtMs)) {
      errors.push(
        `expiresAt must be a valid timestamp, got "${quote.expiresAt}"`,
      );
    } else if (expiresAtMs < now + 10_000) {
      errors.push(
        `expiresAt must be at least 10s in the future, got "${quote.expiresAt}" (${Math.round((expiresAtMs - now) / 1000)}s from now)`,
      );
    }

    // Validate quoteId is non-empty
    if (!quote.quoteId || quote.quoteId.trim() === '') {
      errors.push(`quoteId must be non-empty, got "${quote.quoteId}"`);
    }

    if (errors.length > 0) {
      throw new StableFxRfqError('invalid_response', errors.join('; '), {
        quote,
        validationErrors: errors,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Supported Pair Enforcement
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Enforces that the requested token pair is in the supported pairs registry.
   * Rejects unsupported pairs without calling the Circle API.
   *
   * @throws StableFxRfqError with code 'invalid_response' if pair is not supported
   */
  enforceSupportedPair(fromCurrency: string, toCurrency: string): void {
    const registry = this.getTokenPairRegistry();
    const isSupported = registry.pairs.some(
      (p) =>
        p.enabled &&
        p.fromCurrency === fromCurrency &&
        p.toCurrency === toCurrency,
    );

    if (!isSupported) {
      throw new StableFxRfqError(
        'invalid_response',
        `Token pair ${fromCurrency}/${toCurrency} is not supported. ` +
          `Only documented pairs in the token pair registry are accepted.`,
        { fromCurrency, toCurrency },
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rate Anomaly Detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compares the current quote rate against the previous quote for the same pair
   * within a 60-second window. Logs a warning if deviation exceeds 5%.
   * The quote is still accepted if all other validations pass.
   *
   * @param fromCurrency - Source currency
   * @param toCurrency - Destination currency
   * @param quote - The current quote to compare
   */
  detectRateAnomaly(
    fromCurrency: string,
    toCurrency: string,
    quote: RfqQuote,
  ): void {
    const pairKey = `${fromCurrency}/${toCurrency}`;
    const currentRate = parseFloat(quote.rate);
    const now = Date.now();

    const previous = this.quoteHistory.get(pairKey);

    if (previous && now - previous.timestamp <= RATE_ANOMALY_WINDOW_MS) {
      const deviationPercent =
        Math.abs((currentRate - previous.rate) / previous.rate) * 100;

      if (deviationPercent > RATE_ANOMALY_THRESHOLD_PERCENT) {
        this.logger.warn(
          `[rate-anomaly] Pair ${pairKey}: rate deviation ${deviationPercent.toFixed(2)}% ` +
            `(previous=${previous.rate}, current=${currentRate}, quoteId=${quote.quoteId}). ` +
            `Threshold: ${RATE_ANOMALY_THRESHOLD_PERCENT}%`,
        );
      }
    }

    // Update history with current quote
    this.quoteHistory.set(pairKey, { rate: currentRate, timestamp: now });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Makes an HTTP request to the Circle StableFX API with 30-second timeout.
   * Categorizes all errors explicitly.
   *
   * @throws StableFxRfqError with appropriate error code
   */
  private async callApi<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const baseUrl = this.configService.get<string>('STABLEFX_API_BASE_URL');
    if (!baseUrl) {
      throw new StableFxRfqError(
        'api_error',
        'STABLEFX_API_BASE_URL is not configured',
      );
    }

    const apiKey = this.configService.get<string>('STABLEFX_API_KEY');
    if (!apiKey) {
      throw new StableFxRfqError(
        'api_error',
        'STABLEFX_API_KEY is not configured',
      );
    }

    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      };

      if (body && method === 'POST') {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        if (response.status === 401) {
          throw new StableFxRfqError(
            'auth_entitlement_blocked',
            'Circle StableFX RFQ returned 401 Unauthorized. StableFX entitlement or API authentication is required before FX execution can continue.',
            { status: response.status, path, errorBody },
          );
        }

        throw new StableFxRfqError(
          'api_error',
          `Circle StableFX API returned ${response.status}: ${errorBody}`,
          { status: response.status, path, errorBody },
        );
      }

      const data = (await response.json()) as T;
      return data;
    } catch (error) {
      if (error instanceof StableFxRfqError) {
        throw error;
      }

      // AbortError indicates timeout
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new StableFxRfqError(
          'network_timeout',
          `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`,
          { path, timeoutMs: REQUEST_TIMEOUT_MS },
        );
      }

      // All other errors are network/fetch failures
      throw new StableFxRfqError(
        'network_timeout',
        `Network error calling ${path}: ${error instanceof Error ? error.message : String(error)}`,
        {
          path,
          originalError: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Logs a quote to the task log (via logger for now; will integrate with TaskLogService).
   */
  private logQuote(
    quote: RfqQuote,
    params: QuoteRequest,
    requestTimestamp: string,
  ): void {
    this.logger.log(
      `[quote-log] quoteId=${quote.quoteId} rate=${quote.rate} ` +
        `expiresAt=${quote.expiresAt} requestTimestamp=${requestTimestamp} ` +
        `sourceToken=${params.fromCurrency} destToken=${params.toCurrency} ` +
        `amount=${params.fromAmount ?? params.toAmount}`,
    );
  }

  /**
   * Returns the token pair registry, loading from config on first access.
   */
  private getTokenPairRegistry(): TokenPairRegistry {
    if (!this.tokenPairRegistry) {
      const pairsConfig = this.configService.get<string>(
        'STABLEFX_SUPPORTED_PAIRS',
      );

      if (pairsConfig) {
        try {
          this.tokenPairRegistry = JSON.parse(pairsConfig) as TokenPairRegistry;
        } catch {
          this.logger.warn(
            '[token-pair-registry] Failed to parse STABLEFX_SUPPORTED_PAIRS config, using defaults',
          );
          this.tokenPairRegistry = this.getDefaultRegistry();
        }
      } else {
        this.tokenPairRegistry = this.getDefaultRegistry();
      }
    }

    return this.tokenPairRegistry;
  }

  /**
   * Returns the default token pair registry with USDC/EURC pairs.
   */
  private getDefaultRegistry(): TokenPairRegistry {
    return {
      pairs: [
        {
          fromCurrency: 'USDC',
          toCurrency: 'EURC',
          minAmount: '10',
          enabled: true,
        },
        {
          fromCurrency: 'EURC',
          toCurrency: 'USDC',
          minAmount: '10',
          enabled: true,
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
  }
}
