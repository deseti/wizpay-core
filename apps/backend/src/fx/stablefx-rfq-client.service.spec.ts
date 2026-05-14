import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  StableFXRfqClient,
  StableFxRfqError,
} from './stablefx-rfq-client.service';
import { RfqQuote, QuoteRequest } from './fx.types';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('StableFXRfqClient', () => {
  let service: StableFXRfqClient;
  let configService: ConfigService;

  const defaultConfig: Record<string, string> = {
    STABLEFX_API_BASE_URL: 'https://api.circle.com/stablefx/v1',
    STABLEFX_API_KEY: 'test-api-key',
    STABLEFX_SUPPORTED_PAIRS: JSON.stringify({
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
        {
          fromCurrency: 'USDC',
          toCurrency: 'GBP',
          minAmount: '10',
          enabled: false,
        },
      ],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    }),
  };

  function createService(configOverrides?: Record<string, string | undefined>) {
    const config = { ...defaultConfig, ...configOverrides };
    return Test.createTestingModule({
      providers: [
        StableFXRfqClient,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => config[key]),
          },
        },
      ],
    }).compile();
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await createService();
    service = module.get(StableFXRfqClient);
    configService = module.get(ConfigService);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Quote Validation
  // ─────────────────────────────────────────────────────────────────────────────

  describe('validateQuote()', () => {
    function makeValidQuote(overrides?: Partial<RfqQuote>): RfqQuote {
      return {
        quoteId: 'quote-123',
        rate: '1.08',
        fromAmount: '1000',
        toAmount: '1080',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
        ...overrides,
      };
    }

    it('accepts a valid quote with non-zero rate, future expiry, and non-empty quoteId', () => {
      const quote = makeValidQuote();
      expect(() => service.validateQuote(quote)).not.toThrow();
    });

    it('rejects a quote with rate of zero', () => {
      const quote = makeValidQuote({ rate: '0' });
      expect(() => service.validateQuote(quote)).toThrow(StableFxRfqError);
      expect(() => service.validateQuote(quote)).toThrow(
        /rate must be non-zero/,
      );
    });

    it('rejects a quote with negative rate', () => {
      const quote = makeValidQuote({ rate: '-0.5' });
      expect(() => service.validateQuote(quote)).toThrow(
        /rate must be non-zero/,
      );
    });

    it('rejects a quote with non-numeric rate', () => {
      const quote = makeValidQuote({ rate: 'abc' });
      expect(() => service.validateQuote(quote)).toThrow(
        /rate must be non-zero/,
      );
    });

    it('rejects a quote with empty rate', () => {
      const quote = makeValidQuote({ rate: '' });
      expect(() => service.validateQuote(quote)).toThrow(
        /rate must be non-zero/,
      );
    });

    it('rejects a quote with expiresAt in the past', () => {
      const quote = makeValidQuote({
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      expect(() => service.validateQuote(quote)).toThrow(
        /expiresAt must be at least 10s/,
      );
    });

    it('rejects a quote with expiresAt less than 10s in the future', () => {
      const quote = makeValidQuote({
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
      });
      expect(() => service.validateQuote(quote)).toThrow(
        /expiresAt must be at least 10s/,
      );
    });

    it('accepts a quote with expiresAt exactly 10s in the future', () => {
      const quote = makeValidQuote({
        expiresAt: new Date(Date.now() + 11_000).toISOString(),
      });
      expect(() => service.validateQuote(quote)).not.toThrow();
    });

    it('rejects a quote with invalid expiresAt timestamp', () => {
      const quote = makeValidQuote({ expiresAt: 'not-a-date' });
      expect(() => service.validateQuote(quote)).toThrow(
        /expiresAt must be a valid timestamp/,
      );
    });

    it('rejects a quote with empty quoteId', () => {
      const quote = makeValidQuote({ quoteId: '' });
      expect(() => service.validateQuote(quote)).toThrow(
        /quoteId must be non-empty/,
      );
    });

    it('rejects a quote with whitespace-only quoteId', () => {
      const quote = makeValidQuote({ quoteId: '   ' });
      expect(() => service.validateQuote(quote)).toThrow(
        /quoteId must be non-empty/,
      );
    });

    it('reports all validation errors at once', () => {
      const quote = makeValidQuote({
        rate: '0',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        quoteId: '',
      });
      try {
        service.validateQuote(quote);
        fail('Expected error');
      } catch (e) {
        expect(e).toBeInstanceOf(StableFxRfqError);
        const err = e as StableFxRfqError;
        expect(err.code).toBe('invalid_response');
        expect(err.message).toContain('rate');
        expect(err.message).toContain('expiresAt');
        expect(err.message).toContain('quoteId');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Supported Pair Enforcement
  // ─────────────────────────────────────────────────────────────────────────────

  describe('enforceSupportedPair()', () => {
    it('allows a supported and enabled pair (USDC/EURC)', () => {
      expect(() => service.enforceSupportedPair('USDC', 'EURC')).not.toThrow();
    });

    it('allows a supported and enabled pair (EURC/USDC)', () => {
      expect(() => service.enforceSupportedPair('EURC', 'USDC')).not.toThrow();
    });

    it('rejects a pair that is in registry but disabled', () => {
      expect(() => service.enforceSupportedPair('USDC', 'GBP')).toThrow(
        StableFxRfqError,
      );
      expect(() => service.enforceSupportedPair('USDC', 'GBP')).toThrow(
        /not supported/,
      );
    });

    it('rejects a completely undocumented pair', () => {
      expect(() => service.enforceSupportedPair('BTC', 'ETH')).toThrow(
        /not supported/,
      );
    });

    it('rejects reversed pair that is not explicitly listed', () => {
      // GBP/USDC is not in registry (only USDC/GBP which is disabled)
      expect(() => service.enforceSupportedPair('GBP', 'USDC')).toThrow(
        /not supported/,
      );
    });

    it('does not call the Circle API for unsupported pairs', async () => {
      try {
        await service.requestQuote({
          fromCurrency: 'BTC',
          toCurrency: 'ETH',
          fromAmount: '100',
          tenor: 'instant',
        });
      } catch {
        // Expected to throw
      }

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error Categorization
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Error categorization', () => {
    const validRequest: QuoteRequest = {
      fromCurrency: 'USDC',
      toCurrency: 'EURC',
      fromAmount: '1000',
      tenor: 'instant',
    };

    it('categorizes timeout as network_timeout', async () => {
      mockFetch.mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      await expect(service.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'network_timeout',
      });
    });

    it('categorizes API error responses as api_error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(service.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'api_error',
      });
    });

    it('categorizes API 4xx responses as api_error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });

      await expect(service.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'api_error',
      });
    });

    it('categorizes Circle StableFX 401 as auth_entitlement_blocked', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(service.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'auth_entitlement_blocked',
        message: expect.stringContaining('entitlement or API authentication'),
      });
    });

    it('categorizes invalid response (missing fields) as invalid_response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            quoteId: '',
            rate: '0',
            fromAmount: '1000',
            toAmount: '0',
            fee: '0',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            tenor: 'instant',
          }),
      });

      await expect(service.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });

    it('categorizes network errors as network_timeout', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'network_timeout',
      });
    });

    it('throws api_error when STABLEFX_API_BASE_URL is not configured', async () => {
      const module = await createService({ STABLEFX_API_BASE_URL: undefined });
      const svc = module.get(StableFXRfqClient);

      await expect(svc.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'api_error',
        message: expect.stringContaining('STABLEFX_API_BASE_URL'),
      });
    });

    it('throws api_error when STABLEFX_API_KEY is not configured', async () => {
      const module = await createService({ STABLEFX_API_KEY: undefined });
      const svc = module.get(StableFXRfqClient);

      await expect(svc.requestQuote(validRequest)).rejects.toMatchObject({
        code: 'api_error',
        message: expect.stringContaining('STABLEFX_API_KEY'),
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Rate Anomaly Detection
  // ─────────────────────────────────────────────────────────────────────────────

  describe('detectRateAnomaly()', () => {
    let logWarnSpy: jest.SpyInstance;

    beforeEach(() => {
      logWarnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation();
    });

    it('does not warn on first quote (no previous to compare)', () => {
      const quote: RfqQuote = {
        quoteId: 'q1',
        rate: '1.08',
        fromAmount: '1000',
        toAmount: '1080',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };

      service.detectRateAnomaly('USDC', 'EURC', quote);
      expect(logWarnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when rate deviation is within threshold', () => {
      const quote1: RfqQuote = {
        quoteId: 'q1',
        rate: '1.08',
        fromAmount: '1000',
        toAmount: '1080',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };
      const quote2: RfqQuote = {
        ...quote1,
        quoteId: 'q2',
        rate: '1.09', // ~0.9% deviation
      };

      service.detectRateAnomaly('USDC', 'EURC', quote1);
      service.detectRateAnomaly('USDC', 'EURC', quote2);

      expect(logWarnSpy).not.toHaveBeenCalled();
    });

    it('warns when rate deviation exceeds threshold (>5%)', () => {
      const quote1: RfqQuote = {
        quoteId: 'q1',
        rate: '1.00',
        fromAmount: '1000',
        toAmount: '1000',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };
      const quote2: RfqQuote = {
        ...quote1,
        quoteId: 'q2',
        rate: '1.06', // 6% deviation
      };

      service.detectRateAnomaly('USDC', 'EURC', quote1);
      service.detectRateAnomaly('USDC', 'EURC', quote2);

      expect(logWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('rate-anomaly'),
      );
    });

    it('warns on exactly 5.01% deviation', () => {
      const quote1: RfqQuote = {
        quoteId: 'q1',
        rate: '1.00',
        fromAmount: '1000',
        toAmount: '1000',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };
      const quote2: RfqQuote = {
        ...quote1,
        quoteId: 'q2',
        rate: '1.0501', // 5.01% deviation
      };

      service.detectRateAnomaly('USDC', 'EURC', quote1);
      service.detectRateAnomaly('USDC', 'EURC', quote2);

      expect(logWarnSpy).toHaveBeenCalled();
    });

    it('does not warn on exactly 5% deviation (threshold is >5%)', () => {
      const quote1: RfqQuote = {
        quoteId: 'q1',
        rate: '2.00',
        fromAmount: '1000',
        toAmount: '1000',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };
      const quote2: RfqQuote = {
        ...quote1,
        quoteId: 'q2',
        rate: '2.09', // 4.5% deviation — below threshold
      };

      service.detectRateAnomaly('USDC', 'EURC', quote1);
      service.detectRateAnomaly('USDC', 'EURC', quote2);

      expect(logWarnSpy).not.toHaveBeenCalled();
    });

    it('does not compare quotes for different pairs', () => {
      const quote1: RfqQuote = {
        quoteId: 'q1',
        rate: '1.00',
        fromAmount: '1000',
        toAmount: '1000',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };
      const quote2: RfqQuote = {
        ...quote1,
        quoteId: 'q2',
        rate: '2.00', // 100% deviation but different pair
      };

      service.detectRateAnomaly('USDC', 'EURC', quote1);
      service.detectRateAnomaly('EURC', 'USDC', quote2);

      expect(logWarnSpy).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // No-Fallback Behavior
  // ─────────────────────────────────────────────────────────────────────────────

  describe('No-fallback behavior', () => {
    const validRequest: QuoteRequest = {
      fromCurrency: 'USDC',
      toCurrency: 'EURC',
      fromAmount: '1000',
      tenor: 'instant',
    };

    it('throws on network timeout without any fallback', async () => {
      mockFetch.mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      await expect(service.requestQuote(validRequest)).rejects.toThrow(
        StableFxRfqError,
      );
      // No fallback value returned
    });

    it('throws on API error without any fallback', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      });

      await expect(service.requestQuote(validRequest)).rejects.toThrow(
        StableFxRfqError,
      );
    });

    it('throws on invalid response without any fallback', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            quoteId: '',
            rate: '0',
            expiresAt: '',
            fromAmount: '',
            toAmount: '',
            fee: '',
            tenor: '',
          }),
      });

      await expect(service.requestQuote(validRequest)).rejects.toThrow(
        StableFxRfqError,
      );
    });

    it('never returns a cached or default rate on failure', async () => {
      // First call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            quoteId: 'q1',
            rate: '1.08',
            fromAmount: '1000',
            toAmount: '1080',
            fee: '0.50',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            tenor: 'instant',
          }),
      });

      await service.requestQuote(validRequest);

      // Second call fails — should NOT return cached quote
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(service.requestQuote(validRequest)).rejects.toThrow(
        StableFxRfqError,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // requestQuote() integration
  // ─────────────────────────────────────────────────────────────────────────────

  describe('requestQuote()', () => {
    it('returns a valid quote on successful API call', async () => {
      const validQuote = {
        quoteId: 'quote-abc',
        rate: '1.08',
        fromAmount: '1000',
        toAmount: '1080',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(validQuote),
      });

      const result = await service.requestQuote({
        fromCurrency: 'USDC',
        toCurrency: 'EURC',
        fromAmount: '1000',
        tenor: 'instant',
      });

      expect(result).toEqual(validQuote);
    });

    it('calls the correct API endpoint with proper headers', async () => {
      const validQuote = {
        quoteId: 'quote-abc',
        rate: '1.08',
        fromAmount: '1000',
        toAmount: '1080',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(validQuote),
      });

      await service.requestQuote({
        fromCurrency: 'USDC',
        toCurrency: 'EURC',
        fromAmount: '1000',
        tenor: 'instant',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.circle.com/stablefx/v1/quotes',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // createTrade()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('createTrade()', () => {
    it('calls POST /trades with quoteId and signature', async () => {
      const tradeResponse = {
        tradeId: 'trade-123',
        status: 'confirmed',
        quoteId: 'quote-abc',
        fromAmount: '1000',
        toAmount: '1080',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(tradeResponse),
      });

      const result = await service.createTrade('quote-abc', 'sig-xyz');

      expect(result).toEqual(tradeResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.circle.com/stablefx/v1/trades',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ quoteId: 'quote-abc', signature: 'sig-xyz' }),
        }),
      );
    });

    it('throws invalid_response when quoteId is empty', async () => {
      await expect(service.createTrade('', 'sig')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });

    it('throws invalid_response when signature is empty', async () => {
      await expect(service.createTrade('quote-1', '')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getTradeStatus()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('getTradeStatus()', () => {
    it('calls GET /trades/{tradeId}', async () => {
      const statusResponse = {
        tradeId: 'trade-123',
        status: 'completed',
        fromAmount: '1000',
        toAmount: '1080',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(statusResponse),
      });

      const result = await service.getTradeStatus('trade-123');

      expect(result).toEqual(statusResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.circle.com/stablefx/v1/trades/trade-123',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('throws invalid_response when tradeId is empty', async () => {
      await expect(service.getTradeStatus('')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getSupportedPairs()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('getSupportedPairs()', () => {
    it('returns only enabled pairs from the registry', async () => {
      const pairs = await service.getSupportedPairs();

      expect(pairs).toHaveLength(2);
      expect(pairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromCurrency: 'USDC',
            toCurrency: 'EURC',
            enabled: true,
          }),
          expect.objectContaining({
            fromCurrency: 'EURC',
            toCurrency: 'USDC',
            enabled: true,
          }),
        ]),
      );
    });

    it('does not return disabled pairs', async () => {
      const pairs = await service.getSupportedPairs();

      const gbpPair = pairs.find((p) => p.toCurrency === 'GBP');
      expect(gbpPair).toBeUndefined();
    });

    it('uses default registry when config is not set', async () => {
      const module = await createService({
        STABLEFX_SUPPORTED_PAIRS: undefined,
      });
      const svc = module.get(StableFXRfqClient);

      const pairs = await svc.getSupportedPairs();

      expect(pairs).toHaveLength(2);
      expect(pairs[0]).toMatchObject({
        fromCurrency: 'USDC',
        toCurrency: 'EURC',
      });
      expect(pairs[1]).toMatchObject({
        fromCurrency: 'EURC',
        toCurrency: 'USDC',
      });
    });
  });
});
