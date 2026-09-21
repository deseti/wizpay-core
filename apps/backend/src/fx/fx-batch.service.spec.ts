import { FxBatchService, BatchLeg } from './fx-batch.service';

describe('FxBatchService', () => {
  let service: FxBatchService;

  beforeEach(() => {
    service = new FxBatchService();
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
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateBatch() - Invalid batches
  // ─────────────────────────────────────────────────────────────────────────────

  describe('validateBatch() - invalid batches', () => {
    it('rejects an empty batch', () => {
      const result = service.validateBatch([]);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].legIndex).toBe(-1);
    });

    it('rejects a batch exceeding the maximum size', () => {
      const legs: BatchLeg[] = Array.from({ length: 201 }, (_, i) => ({
        recipient: `0x${String(i).padStart(40, '1')}`,
        amount: '1.00',
        sourceToken: 'USDC',
        destinationToken: 'USDC',
        minOutput: '1.00',
      }));

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].legIndex).toBe(-1);
    });

    it('rejects legs with empty recipients', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'USDC',
          minOutput: '100.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].legIndex).toBe(0);
    });

    it('rejects legs with the zero address', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x0000000000000000000000000000000000000000',
          amount: '100.00',
          sourceToken: 'USDC',
          destinationToken: 'USDC',
          minOutput: '100.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toMatch(/zero address/);
    });

    it('rejects legs with non-numeric amounts', () => {
      const legs: BatchLeg[] = [
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: 'not-a-number',
          sourceToken: 'USDC',
          destinationToken: 'USDC',
          minOutput: '1.00',
        },
      ];

      const result = service.validateBatch(legs);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toMatch(/not a valid number/);
    });

    it('rejects legs with zero or negative amounts', () => {
      for (const amount of ['0', '-5']) {
        const result = service.validateBatch([
          {
            recipient: '0x1234567890abcdef1234567890abcdef12345678',
            amount,
            sourceToken: 'USDC',
            destinationToken: 'USDC',
            minOutput: '1.00',
          },
        ]);

        expect(result.valid).toBe(false);
      }
    });

    it('rejects legs below the minimum amount', () => {
      const result = service.validateBatch([
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '0.001',
          sourceToken: 'USDC',
          destinationToken: 'USDC',
          minOutput: '0.001',
        },
      ]);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toMatch(/below minimum/);
    });

    it('rejects legs above the maximum amount', () => {
      const result = service.validateBatch([
        {
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          amount: '1000000000',
          sourceToken: 'USDC',
          destinationToken: 'USDC',
          minOutput: '1.00',
        },
      ]);

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toMatch(/exceeds maximum/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // executeCrossCurrencyBatch() - Mainnet fail-closed
  // ─────────────────────────────────────────────────────────────────────────────

  describe('executeCrossCurrencyBatch() - Mainnet fail-closed', () => {
    it('refuses backend batch execution without side effects', async () => {
      await expect(
        service.executeCrossCurrencyBatch(
          [
            {
              recipient: '0x1234567890abcdef1234567890abcdef12345678',
              amount: '100.00',
              sourceToken: 'USDC',
              destinationToken: 'EURC',
              minOutput: '95.00',
            },
          ],
          'batch-ref',
        ),
      ).rejects.toMatchObject({
        response: { code: 'FX_BATCH_EXECUTION_UNAVAILABLE' },
      });
    });
  });
});
