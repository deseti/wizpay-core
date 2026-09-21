import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { QuoteRequest, RfqQuote } from './fx.types';

/**
 * Job options for FX retry configuration.
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
 * FxRetryService handles retry policy for FX operations on Arc Mainnet.
 *
 * Responsibilities:
 * - Provide retry configuration (3 attempts, exponential backoff 1s base)
 * - Check quote freshness before retry attempts
 *
 * Quote refresh is retired: there is no backend quote provider on Mainnet.
 * A still-valid quote is reused; an expired quote fails closed so the
 * external wallet re-quotes through the Uniswap V4 flow.
 */
@Injectable()
export class FxRetryService {
  private readonly logger = new Logger(FxRetryService.name);

  /**
   * Returns retry configuration for FX jobs.
   *
   * Configuration:
   * - Maximum 3 attempts
   * - Exponential backoff with 1-second base delay (1s, 2s, 4s)
   *
   * @returns Retry configuration with attempts and backoff
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
   * - If the previous quote is still valid, it is reused.
   * - If the previous quote expired, fails closed: the caller must obtain
   *   a new quote through the external-wallet Uniswap V4 flow.
   *
   * @param previousQuote - The quote obtained in the previous attempt
   * @param params - Original quote request parameters (informational)
   * @returns The quote to use with metadata
   */
  async ensureFreshQuote(
    previousQuote: RfqQuote,
    params: QuoteRequest,
  ): Promise<EnsureFreshQuoteResult> {
    void params;
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

    // Quote has expired and there is no backend provider to refresh it.
    this.logger.warn(
      `[fx-retry] Quote ${previousQuote.quoteId} expired ` +
        `(expiresAt=${previousQuote.expiresAt}); refusing refresh on Arc Mainnet.`,
    );
    throw new ServiceUnavailableException({
      code: 'FX_QUOTE_REFRESH_UNAVAILABLE',
      message:
        'The FX quote expired and cannot be refreshed by the backend. Obtain a new quote through the external-wallet Uniswap V4 flow.',
    });
  }

  /**
   * Checks if a quote's expiresAt timestamp has elapsed.
   *
   * A quote is considered expired if its expiresAt timestamp is in the past
   * relative to the current server time.
   *
   * @param quote - The quote to check
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
