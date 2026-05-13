import { Injectable, Logger } from '@nestjs/common';
import { QuoteRequest, RfqQuote } from './fx.types';
import { StableFXRfqClient } from './stablefx-rfq-client.service';

/**
 * BullMQ job options for FX retry configuration.
 */
export interface FxRetryJobOptions {
  attempts: number;
  backoff: {
    type: 'exponential';
    delay: number;
  };
}

/**
 * Result of the ensureFreshQuote operation.
 */
export interface EnsureFreshQuoteResult {
  quote: RfqQuote;
  wasRefreshed: boolean;
  expiredQuoteId?: string;
}

/**
 * FxRetryService handles retry logic for FX operations.
 *
 * Responsibilities:
 * - Provide BullMQ retry configuration (3 attempts, exponential backoff 1s base)
 * - Check quote freshness before retry attempts
 * - Request fresh quotes when previous quotes have expired
 * - Log both expired and new quote IDs for audit trail
 *
 * Requirements: 5.3, 5.4
 */
@Injectable()
export class FxRetryService {
  private readonly logger = new Logger(FxRetryService.name);

  constructor(private readonly rfqClient: StableFXRfqClient) {}

  /**
   * Returns BullMQ job options configured for FX retry policy.
   *
   * Configuration:
   * - Maximum 3 attempts
   * - Exponential backoff with 1-second base delay (1s, 2s, 4s)
   *
   * @returns BullMQ-compatible job options with retry configuration
   */
  getRetryOptions(): FxRetryJobOptions {
    return {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    };
  }

  /**
   * Ensures a fresh quote is available for retry attempts.
   *
   * On transient failure retry:
   * - Checks if the previously obtained quote's expiresAt has elapsed
   * - If expired: requests a fresh quote via StableFXRfqClient, logs both
   *   the expired quote ID and the new quote ID
   * - If still valid: reuses the original quote
   *
   * @param previousQuote - The quote obtained in the previous attempt
   * @param params - Original quote request parameters for requesting a fresh quote
   * @returns The quote to use (either original or fresh) with metadata
   */
  async ensureFreshQuote(
    previousQuote: RfqQuote,
    params: QuoteRequest,
  ): Promise<EnsureFreshQuoteResult> {
    if (!this.isQuoteExpired(previousQuote)) {
      this.logger.log(
        `[fx-retry] Quote ${previousQuote.quoteId} still valid ` +
          `(expiresAt=${previousQuote.expiresAt}), reusing for retry`,
      );

      return {
        quote: previousQuote,
        wasRefreshed: false,
      };
    }

    // Quote has expired — request a fresh one
    this.logger.log(
      `[fx-retry] Quote ${previousQuote.quoteId} expired ` +
        `(expiresAt=${previousQuote.expiresAt}), requesting fresh quote`,
    );

    const freshQuote = await this.rfqClient.requestQuote(params);

    this.logger.log(
      `[fx-retry] Fresh quote obtained: expiredQuoteId=${previousQuote.quoteId} ` +
        `newQuoteId=${freshQuote.quoteId} rate=${freshQuote.rate} ` +
        `expiresAt=${freshQuote.expiresAt}`,
    );

    return {
      quote: freshQuote,
      wasRefreshed: true,
      expiredQuoteId: previousQuote.quoteId,
    };
  }

  /**
   * Checks if a quote's expiresAt timestamp has elapsed.
   *
   * A quote is considered expired if its expiresAt timestamp is in the past
   * relative to the current server time.
   *
   * @param quote - The RFQ quote to check
   * @returns true if the quote has expired, false if still valid
   */
  isQuoteExpired(quote: RfqQuote): boolean {
    const expiresAtMs = Date.parse(quote.expiresAt);

    if (isNaN(expiresAtMs)) {
      // Invalid timestamp — treat as expired (fail closed)
      this.logger.warn(
        `[fx-retry] Quote ${quote.quoteId} has invalid expiresAt: "${quote.expiresAt}", treating as expired`,
      );
      return true;
    }

    return Date.now() >= expiresAtMs;
  }
}
