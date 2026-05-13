import { FxBatchService, BatchLeg } from './fx-batch.service';
import { StableFXRfqClient } from './stablefx-rfq-client.service';

describe('FxBatchService', () => {
  let service: FxBatchService;
  let mockRfqClient: jest.Mocked<Pick<StableFXRfqClient, 'requestQuote' | 'createTrade'>>;

  beforeEach(() => {
    mockRfqClient = {
      requestQuote: jest.fn(),
      createTrade: jest.fn(),
    };
    service = new FxBatchService(mockRfqClient as unknown as StableFXRfqClient);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateBatch() - Valid batches
  // ─────────────────────────────────────────────────────────────────────────────

  describe('validateBatch() - valid batches', () => {
    it('accepts a valid single-leg batch', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '95.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts a valid multi-leg batch', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1111111111111111111111111111111111111111',
          amount: '50.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '47.00',
        },
        {
          recipient: '0x2222222222222222222222222222222222222222',
          amount: '200.50',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '190.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts minimum amount (0.01)', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '0.01',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '0.009',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(true);
    });

    it('accepts maximum amount (999999999.99)', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '999999999.99',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '950000000.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(true);
    });

    it('accepts a batch with exactly 200 legs', () => {
      const legs: BatchLeg[] = Array.from({ length: 200 }, (_, i) => ({
        recipient: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        amount: '10.00',
        sourceToken: 'USDC',
        destinationToken: 'EURC',
        minOutput: '9.50',
      }));

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateBatch() - Invalid batches (atomic rejection)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('validateBatch() - invalid batches (atomic rejection)', () => {
    it('rejects empty batch (size 0)', () => {
      const result = service.validateBatch([]);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('at least');
    });

    it('rejects oversized batch (> 200 legs)', () => {
      const legs: BatchLeg[] = Array.from({ length: 201 }, (_, i) => ({
        recipient: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        amount: '10.00',
        sourceToken: 'USDC',
        destinationToken: 'EURC',
        minOutput: '9.50',
      }));

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('at most 200');
    });

    it('rejects batch with zero address recipient', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x0000000000000000000000000000000000000000',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '95.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].legIndex).toBe(0);
      expect(result.errors[0].error).toContain('zero address');
    });

    it('rejects batch with empty recipient', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '95.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('empty');
    });

    it('rejects batch with zero amount', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '0',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '0',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('greater than zero');
    });

    it('rejects batch with negative amount', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '-50.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '0',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('greater than zero');
    });

    it('rejects batch with amount below minimum (< 0.01)', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '0.009',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '0.008',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('below minimum');
    });

    it('rejects batch with amount above maximum (> 999,999,999.99)', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '1000000000.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '950000000.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('exceeds maximum');
    });

    it('rejects batch with non-numeric amount', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: 'abc',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '95.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('not a valid number');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateBatch() - Per-leg error details
  // ─────────────────────────────────────────────────────────────────────────────

  describe('validateBatch() - per-leg error details', () => {
    it('reports errors for multiple invalid legs', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '95.00',
        },
        {
          recipient: '0x0000000000000000000000000000000000000000',
          amount: '50.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '47.00',
        },
        {
          recipient: '0x3333333333333333333333333333333333333333',
          amount: '-10.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '0',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);

      // Leg 1: zero address
      expect(result.errors[0].legIndex).toBe(1);
      expect(result.errors[0].recipient).toBe('0x0000000000000000000000000000000000000000');
      expect(result.errors[0].error).toContain('zero address');

      // Leg 2: negative amount
      expect(result.errors[1].legIndex).toBe(2);
      expect(result.errors[1].amount).toBe('-10.00');
      expect(result.errors[1].error).toContain('greater than zero');
    });

    it('includes legIndex, recipient, amount, and error in each error entry', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x0000000000000000000000000000000000000000',
          amount: '0',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '0',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toHaveProperty('legIndex', 0);
      expect(result.errors[0]).toHaveProperty('recipient', '0x0000000000000000000000000000000000000000');
      expect(result.errors[0]).toHaveProperty('amount', '0');
      expect(result.errors[0]).toHaveProperty('error');
      expect(result.errors[0].error.length).toBeGreaterThan(0);
    });

    it('reports multiple errors for a single leg with multiple issues', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x0000000000000000000000000000000000000000',
          amount: '-5.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '0',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      // Both errors combined in one entry
      expect(result.errors[0].error).toContain('zero address');
      expect(result.errors[0].error).toContain('greater than zero');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // executeCrossCurrencyBatch() - Mixed success/failure
  // ─────────────────────────────────────────────────────────────────────────────

  describe('executeCrossCurrencyBatch() - cross-currency execution', () => {
    const validLegs: BatchLeg[] = [
      {
        recipient: '0x1111111111111111111111111111111111111111',
        amount: '100.00',
        sourceToken: 'USDC',
        destinationToken: 'EURC',
        minOutput: '95.00',
      },
      {
        recipient: '0x2222222222222222222222222222222222222222',
        amount: '200.00',
        sourceToken: 'USDC',
        destinationToken: 'EURC',
        minOutput: '190.00',
      },
      {
        recipient: '0x3333333333333333333333333333333333333333',
        amount: '50.00',
        sourceToken: 'USDC',
        destinationToken: 'EURC',
        minOutput: '47.00',
      },
    ];

    it('executes all legs successfully when no failures occur', async () => {
      mockRfqClient.requestQuote.mockResolvedValue({
        quoteId: 'quote-123',
        rate: '0.92',
        fromAmount: '100.00',
        toAmount: '92.00',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      });
      mockRfqClient.createTrade.mockResolvedValue({
        tradeId: 'trade-456',
        status: 'confirmed',
        quoteId: 'quote-123',
        fromAmount: '100.00',
        toAmount: '92.00',
      });

      const result = await service.executeCrossCurrencyBatch(
        validLegs,
        'batch-ref-001',
      );

      expect(result.batchReferenceId).toBe('batch-ref-001');
      expect(result.totalLegs).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.legResults).toHaveLength(3);
      expect(result.legResults.every((r) => r.success)).toBe(true);
    });

    it('continues processing other legs when one leg fails', async () => {
      // First leg succeeds
      mockRfqClient.requestQuote
        .mockResolvedValueOnce({
          quoteId: 'quote-1',
          rate: '0.92',
          fromAmount: '100.00',
          toAmount: '92.00',
          fee: '0.50',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          tenor: 'instant',
        })
        // Second leg fails at quote
        .mockRejectedValueOnce(new Error('API timeout for leg 2'))
        // Third leg succeeds
        .mockResolvedValueOnce({
          quoteId: 'quote-3',
          rate: '0.92',
          fromAmount: '50.00',
          toAmount: '46.00',
          fee: '0.25',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          tenor: 'instant',
        });

      mockRfqClient.createTrade
        .mockResolvedValueOnce({
          tradeId: 'trade-1',
          status: 'confirmed',
          quoteId: 'quote-1',
          fromAmount: '100.00',
          toAmount: '92.00',
        })
        .mockResolvedValueOnce({
          tradeId: 'trade-3',
          status: 'confirmed',
          quoteId: 'quote-3',
          fromAmount: '50.00',
          toAmount: '46.00',
        });

      const result = await service.executeCrossCurrencyBatch(
        validLegs,
        'batch-ref-002',
      );

      expect(result.totalLegs).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);

      // Leg 0: success
      expect(result.legResults[0].success).toBe(true);
      expect(result.legResults[0].quoteId).toBe('quote-1');
      expect(result.legResults[0].tradeId).toBe('trade-1');

      // Leg 1: failure
      expect(result.legResults[1].success).toBe(false);
      expect(result.legResults[1].reason).toContain('API timeout');
      expect(result.legResults[1].legIndex).toBe(1);
      expect(result.legResults[1].recipient).toBe('0x2222222222222222222222222222222222222222');
      expect(result.legResults[1].amount).toBe('200.00');
      expect(result.legResults[1].timestamp).toBeDefined();

      // Leg 2: success (not blocked by leg 1 failure)
      expect(result.legResults[2].success).toBe(true);
      expect(result.legResults[2].quoteId).toBe('quote-3');
    });

    it('records failure details including legIndex, recipient, amount, reason, and timestamp', async () => {
      mockRfqClient.requestQuote.mockRejectedValue(
        new Error('Network unreachable'),
      );

      const result = await service.executeCrossCurrencyBatch(
        [validLegs[0]],
        'batch-ref-003',
      );

      expect(result.failed).toBe(1);
      const failedLeg = result.legResults[0];
      expect(failedLeg.legIndex).toBe(0);
      expect(failedLeg.recipient).toBe('0x1111111111111111111111111111111111111111');
      expect(failedLeg.amount).toBe('100.00');
      expect(failedLeg.reason).toContain('Network unreachable');
      expect(failedLeg.timestamp).toBeDefined();
      expect(new Date(failedLeg.timestamp).getTime()).not.toBeNaN();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // executeCrossCurrencyBatch() - Batch summary completeness
  // ─────────────────────────────────────────────────────────────────────────────

  describe('executeCrossCurrencyBatch() - batch summary', () => {
    it('records complete batch summary on terminal state', async () => {
      mockRfqClient.requestQuote.mockResolvedValue({
        quoteId: 'quote-sum',
        rate: '0.92',
        fromAmount: '100.00',
        toAmount: '92.00',
        fee: '0.50',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenor: 'instant',
      });
      mockRfqClient.createTrade.mockResolvedValue({
        tradeId: 'trade-sum',
        status: 'confirmed',
        quoteId: 'quote-sum',
        fromAmount: '100.00',
        toAmount: '92.00',
      });

      const legs: BatchLeg[] = [
        {
          recipient: '0x1111111111111111111111111111111111111111',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '90.00',
        },
        {
          recipient: '0x2222222222222222222222222222222222222222',
          amount: '200.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '180.00',
        },
      ];

      const result = await service.executeCrossCurrencyBatch(
        legs,
        'batch-summary-001',
      );

      // Batch summary fields
      expect(result.batchReferenceId).toBe('batch-summary-001');
      expect(result.totalLegs).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.totalDisbursed).toBe('184.00'); // 92 + 92
      expect(result.legResults).toHaveLength(2);
    });

    it('calculates totalDisbursed only from successful legs', async () => {
      mockRfqClient.requestQuote
        .mockResolvedValueOnce({
          quoteId: 'quote-ok',
          rate: '0.92',
          fromAmount: '100.00',
          toAmount: '92.00',
          fee: '0.50',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          tenor: 'instant',
        })
        .mockRejectedValueOnce(new Error('Failed'));

      mockRfqClient.createTrade.mockResolvedValue({
        tradeId: 'trade-ok',
        status: 'confirmed',
        quoteId: 'quote-ok',
        fromAmount: '100.00',
        toAmount: '92.00',
      });

      const legs: BatchLeg[] = [
        {
          recipient: '0x1111111111111111111111111111111111111111',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '90.00',
        },
        {
          recipient: '0x2222222222222222222222222222222222222222',
          amount: '200.00',
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          minOutput: '180.00',
        },
      ];

      const result = await service.executeCrossCurrencyBatch(
        legs,
        'batch-partial-001',
      );

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.totalDisbursed).toBe('92.00'); // Only from successful leg
    });
  });
});
