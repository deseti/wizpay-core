import { FxRetryService } from './fx-retry.service';
import { QuoteRequest, RfqQuote } from './fx.types';

describe('FxRetryService', () => {
  let service: FxRetryService;

  beforeEach(() => {
    service = new FxRetryService();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getRetryOptions()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('getRetryOptions()', () => {
    it('returns max 3 attempts', () => {
      const options = service.getRetryOptions();
      expect(options.attempts).toBe(3);
    });

    it('returns exponential backoff type', () => {
      const options = service.getRetryOptions();
      expect(options.backoff.type).toBe('exponential');
    });

    it('returns 1000ms base delay (produces 1s, 2s, 4s backoff)', () => {
      const options = service.getRetryOptions();
      expect(options.backoff.delay).toBe(1000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // isQuoteExpired()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('isQuoteExpired()', () => {
    it('returns true when expiresAt is in the past', () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const quote = makeQuote({ expiresAt: pastDate });

      expect(service.isQuoteExpired(quote)).toBe(true);
    });

    it('returns false when expiresAt is in the future', () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const quote = makeQuote({ expiresAt: futureDate });

      expect(service.isQuoteExpired(quote)).toBe(false);
    });

    it('returns true when expiresAt is exactly now (boundary)', () => {
      // Use a date slightly in the past to avoid timing issues
      const nowDate = new Date(Date.now() - 1).toISOString();
      const quote = makeQuote({ expiresAt: nowDate });

      expect(service.isQuoteExpired(quote)).toBe(true);
    });

    it('returns true when expiresAt is an invalid timestamp (fail closed)', () => {
      const quote = makeQuote({ expiresAt: 'not-a-date' });

      expect(service.isQuoteExpired(quote)).toBe(true);
    });

    it('returns true when expiresAt is empty string (fail closed)', () => {
      const quote = makeQuote({ expiresAt: '' });

      expect(service.isQuoteExpired(quote)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ensureFreshQuote()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('ensureFreshQuote()', () => {
    const params: QuoteRequest = {
      fromCurrency: 'USDC',
      toCurrency: 'EURC',
      fromAmount: '1000',
      tenor: 'instant',
    };

    it('reuses a still-valid quote without refresh', async () => {
      const quote = makeQuote({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const result = await service.ensureFreshQuote(quote, params);

      expect(result).toEqual({ quote, wasRefreshed: false });
    });

    it('fails closed when the quote expired instead of refreshing it', async () => {
      const quote = makeQuote({
        quoteId: 'quote-expired',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      await expect(service.ensureFreshQuote(quote, params)).rejects.toMatchObject(
        {
          response: { code: 'FX_QUOTE_REFRESH_UNAVAILABLE' },
        },
      );
    });
  });

  function makeQuote(overrides: Partial<RfqQuote> = {}): RfqQuote {
    return {
      quoteId: 'quote-123',
      rate: '0.92',
      fromAmount: '1000',
      toAmount: '920',
      fee: '1.5',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tenor: 'instant',
      ...overrides,
    };
  }
});
