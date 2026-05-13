import { FxRetryService, EnsureFreshQuoteResult } from './fx-retry.service';
import { StableFXRfqClient } from './stablefx-rfq-client.service';
import { QuoteRequest, RfqQuote } from './fx.types';

describe('FxRetryService', () => {
  let service: FxRetryService;
  let rfqClient: jest.Mocked<Pick<StableFXRfqClient, 'requestQuote'>>;

  beforeEach(() => {
    rfqClient = {
      requestQuote: jest.fn(),
    };
    service = new FxRetryService(rfqClient as unknown as StableFXRfqClient);
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
  // ensureFreshQuote() - quote still valid
  // ─────────────────────────────────────────────────────────────────────────────

  describe('ensureFreshQuote() - quote still valid', () => {
    it('reuses original quote when not expired', async () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const previousQuote = makeQuote({
        quoteId: 'quote-123',
        expiresAt: futureDate,
      });
      const params = makeQuoteRequest();

      const result = await service.ensureFreshQuote(previousQuote, params);

      expect(result.quote).toBe(previousQuote);
      expect(result.wasRefreshed).toBe(false);
      expect(result.expiredQuoteId).toBeUndefined();
    });

    it('does not call rfqClient.requestQuote when quote is still valid', async () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const previousQuote = makeQuote({ expiresAt: futureDate });
      const params = makeQuoteRequest();

      await service.ensureFreshQuote(previousQuote, params);

      expect(rfqClient.requestQuote).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ensureFreshQuote() - quote expired
  // ─────────────────────────────────────────────────────────────────────────────

  describe('ensureFreshQuote() - quote expired', () => {
    it('requests fresh quote when previous quote is expired', async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const previousQuote = makeQuote({
        quoteId: 'expired-quote-001',
        expiresAt: pastDate,
      });
      const params = makeQuoteRequest();
      const freshQuote = makeQuote({
        quoteId: 'fresh-quote-002',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      rfqClient.requestQuote.mockResolvedValue(freshQuote);

      const result = await service.ensureFreshQuote(previousQuote, params);

      expect(rfqClient.requestQuote).toHaveBeenCalledWith(params);
      expect(result.quote).toBe(freshQuote);
      expect(result.wasRefreshed).toBe(true);
    });

    it('returns the expired quote ID in the result', async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const previousQuote = makeQuote({
        quoteId: 'expired-quote-abc',
        expiresAt: pastDate,
      });
      const params = makeQuoteRequest();
      const freshQuote = makeQuote({
        quoteId: 'fresh-quote-xyz',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      rfqClient.requestQuote.mockResolvedValue(freshQuote);

      const result = await service.ensureFreshQuote(previousQuote, params);

      expect(result.expiredQuoteId).toBe('expired-quote-abc');
    });

    it('passes original quote request params to requestQuote', async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const previousQuote = makeQuote({ expiresAt: pastDate });
      const params: QuoteRequest = {
        fromCurrency: 'EURC',
        toCurrency: 'USDC',
        fromAmount: '500.00',
        tenor: 'hourly',
      };
      const freshQuote = makeQuote({
        quoteId: 'fresh-quote',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      rfqClient.requestQuote.mockResolvedValue(freshQuote);

      await service.ensureFreshQuote(previousQuote, params);

      expect(rfqClient.requestQuote).toHaveBeenCalledWith(params);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ensureFreshQuote() - logging
  // ─────────────────────────────────────────────────────────────────────────────

  describe('ensureFreshQuote() - logging', () => {
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn((service as any).logger, 'log');
    });

    it('logs both expired and new quote IDs when refreshing', async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const previousQuote = makeQuote({
        quoteId: 'old-quote-id',
        expiresAt: pastDate,
      });
      const params = makeQuoteRequest();
      const freshQuote = makeQuote({
        quoteId: 'new-quote-id',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        rate: '1.085',
      });

      rfqClient.requestQuote.mockResolvedValue(freshQuote);

      await service.ensureFreshQuote(previousQuote, params);

      // Verify the log contains both quote IDs
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const freshQuoteLog = logCalls.find(
        (msg: string) =>
          msg.includes('old-quote-id') && msg.includes('new-quote-id'),
      );
      expect(freshQuoteLog).toBeDefined();
      expect(freshQuoteLog).toContain('expiredQuoteId=old-quote-id');
      expect(freshQuoteLog).toContain('newQuoteId=new-quote-id');
    });

    it('logs reuse message when quote is still valid', async () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const previousQuote = makeQuote({
        quoteId: 'valid-quote-id',
        expiresAt: futureDate,
      });
      const params = makeQuoteRequest();

      await service.ensureFreshQuote(previousQuote, params);

      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const reuseLog = logCalls.find(
        (msg: string) =>
          msg.includes('valid-quote-id') && msg.includes('reusing'),
      );
      expect(reuseLog).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeQuote(overrides: Partial<RfqQuote> = {}): RfqQuote {
  return {
    quoteId: 'test-quote-id',
    rate: '1.08',
    fromAmount: '100.00',
    toAmount: '108.00',
    fee: '0.50',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    tenor: 'instant',
    ...overrides,
  };
}

function makeQuoteRequest(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    fromCurrency: 'USDC',
    toCurrency: 'EURC',
    fromAmount: '100.00',
    tenor: 'instant',
    ...overrides,
  };
}
