import { TreasuryService, TreasuryOperationPayload } from './treasury.service';
import { StableFXRfqClient, StableFxRfqError } from '../fx/stablefx-rfq-client.service';
import { FxRetryService } from '../fx/fx-retry.service';
import { SettlementValidator } from '../fx/settlement-validator.service';
import { RfqQuote, TradeResponse } from '../fx/fx.types';

describe('TreasuryService', () => {
  let service: TreasuryService;
  let rfqClient: jest.Mocked<StableFXRfqClient>;
  let fxRetryService: jest.Mocked<FxRetryService>;
  let settlementValidator: jest.Mocked<SettlementValidator>;
  let circleAdapter: any;
  let circleClient: any;

  const mockQuote: RfqQuote = {
    quoteId: 'quote-123',
    rate: '0.92',
    fromAmount: '1000',
    toAmount: '920',
    fee: '1.5',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tenor: 'instant',
  };

  const mockTrade: TradeResponse = {
    tradeId: 'trade-456',
    status: 'confirmed',
    quoteId: 'quote-123',
    fromAmount: '1000',
    toAmount: '920',
  };

  const mockTradeStatus = {
    tradeId: 'trade-456',
    status: 'completed' as const,
    fromAmount: '1000',
    toAmount: '918.50',
    settledAt: new Date().toISOString(),
  };

  beforeEach(() => {
    circleAdapter = {
      createWalletSet: jest.fn(),
      createWallet: jest.fn(),
    };

    circleClient = {
      getWalletClient: jest.fn().mockReturnValue({
        getWalletTokenBalance: jest.fn(),
      }),
    };

    rfqClient = {
      requestQuote: jest.fn().mockResolvedValue(mockQuote),
      createTrade: jest.fn().mockResolvedValue(mockTrade),
      getTradeStatus: jest.fn().mockResolvedValue(mockTradeStatus),
      getSupportedPairs: jest.fn(),
      validateQuote: jest.fn(),
      enforceSupportedPair: jest.fn(),
      detectRateAnomaly: jest.fn(),
    } as any;

    fxRetryService = {
      getRetryOptions: jest.fn().mockReturnValue({
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }),
      ensureFreshQuote: jest.fn().mockResolvedValue({
        quote: mockQuote,
        wasRefreshed: false,
      }),
      isQuoteExpired: jest.fn().mockReturnValue(false),
    } as any;

    settlementValidator = {
      validateOutput: jest.fn().mockReturnValue({
        accepted: true,
        deviationPercent: 0.16,
        alertRequired: false,
      }),
    } as any;

    service = new TreasuryService(
      circleAdapter,
      circleClient,
      rfqClient,
      fxRetryService,
      settlementValidator,
    );

    // Suppress logger output in tests
    jest.spyOn((service as any).logger, 'log').mockImplementation();
    jest.spyOn((service as any).logger, 'error').mockImplementation();
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Same-Token Optimization (Requirement 6.4)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Same-token optimization (direct transfer, no FX)', () => {
    it('should execute direct transfer when source equals destination token', async () => {
      const payload: TreasuryOperationPayload = {
        sourceToken: 'USDC',
        destinationToken: 'USDC',
        amount: '5000',
        minOutput: '5000',
        recipient: '0xRecipient',
        taskId: 'task-001',
      };

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('executed');
      expect(result.transferType).toBe('direct');
      expect(result.settledAmount).toBe('5000');
      expect(result.taskId).toBe('task-001');
    });

    it('should NOT invoke StableFXRfqClient for same-token operations', async () => {
      const payload: TreasuryOperationPayload = {
        sourceToken: 'EURC',
        destinationToken: 'EURC',
        amount: '2500',
        minOutput: '2500',
        recipient: '0xRecipient',
        taskId: 'task-002',
      };

      await service.executeTreasuryOperation(payload);

      expect(rfqClient.requestQuote).not.toHaveBeenCalled();
      expect(rfqClient.createTrade).not.toHaveBeenCalled();
      expect(rfqClient.getTradeStatus).not.toHaveBeenCalled();
    });

    it('should return settled amount equal to input amount for direct transfers', async () => {
      const payload: TreasuryOperationPayload = {
        sourceToken: 'USDC',
        destinationToken: 'USDC',
        amount: '12345.67',
        minOutput: '12345.67',
        recipient: '0xRecipient',
        taskId: 'task-003',
      };

      const result = await service.executeTreasuryOperation(payload);

      expect(result.settledAmount).toBe('12345.67');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Cross-Currency Routing (Requirements 6.1, 6.2)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cross-currency routing through StableFXRfqClient', () => {
    const crossCurrencyPayload: TreasuryOperationPayload = {
      sourceToken: 'USDC',
      destinationToken: 'EURC',
      amount: '1000',
      minOutput: '900',
      recipient: '0xRecipient',
      taskId: 'task-010',
    };

    it('should request quote from StableFXRfqClient for cross-currency ops', async () => {
      await service.executeTreasuryOperation(crossCurrencyPayload);

      expect(rfqClient.requestQuote).toHaveBeenCalledWith({
        fromCurrency: 'USDC',
        toCurrency: 'EURC',
        fromAmount: '1000',
        tenor: 'instant',
      });
    });

    it('should create trade with the received quote', async () => {
      await service.executeTreasuryOperation(crossCurrencyPayload);

      expect(rfqClient.createTrade).toHaveBeenCalledWith(
        'quote-123',
        'task-010',
      );
    });

    it('should poll trade status after creating trade', async () => {
      await service.executeTreasuryOperation(crossCurrencyPayload);

      expect(rfqClient.getTradeStatus).toHaveBeenCalledWith('trade-456');
    });

    it('should validate settlement output via SettlementValidator', async () => {
      await service.executeTreasuryOperation(crossCurrencyPayload);

      expect(settlementValidator.validateOutput).toHaveBeenCalledWith({
        settledAmount: '918.50',
        minAcceptableOutput: '900',
        quotedAmount: '920',
        tolerancePercent: 1,
      });
    });

    it('should return executed status on successful cross-currency settlement', async () => {
      const result = await service.executeTreasuryOperation(crossCurrencyPayload);

      expect(result.status).toBe('executed');
      expect(result.transferType).toBe('fx');
      expect(result.tradeId).toBe('trade-456');
      expect(result.quoteId).toBe('quote-123');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Quote Failure Rejection (Requirement 6.3)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Quote failure rejection (no fallback)', () => {
    const payload: TreasuryOperationPayload = {
      sourceToken: 'USDC',
      destinationToken: 'EURC',
      amount: '1000',
      minOutput: '900',
      recipient: '0xRecipient',
      taskId: 'task-020',
    };

    it('should reject operation on network timeout without fallback', async () => {
      rfqClient.requestQuote.mockRejectedValue(
        new StableFxRfqError('network_timeout', 'Request timed out after 30000ms'),
      );

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('network_timeout');
      expect(result.transferType).toBe('fx');
    });

    it('should reject operation on API error without fallback', async () => {
      rfqClient.requestQuote.mockRejectedValue(
        new StableFxRfqError('api_error', 'Circle API returned 500'),
      );

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('api_error');
    });

    it('should reject operation on invalid response without fallback', async () => {
      rfqClient.requestQuote.mockRejectedValue(
        new StableFxRfqError('invalid_response', 'Rate is zero'),
      );

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('invalid_response');
    });

    it('should NOT attempt trade creation when quote fails', async () => {
      rfqClient.requestQuote.mockRejectedValue(
        new StableFxRfqError('api_error', 'Service unavailable'),
      );

      await service.executeTreasuryOperation(payload);

      expect(rfqClient.createTrade).not.toHaveBeenCalled();
      expect(rfqClient.getTradeStatus).not.toHaveBeenCalled();
    });

    it('should mark task as failed on quote failure', async () => {
      rfqClient.requestQuote.mockRejectedValue(
        new StableFxRfqError('network_timeout', 'Timeout'),
      );

      const result = await service.executeTreasuryOperation(payload);

      expect(result.taskId).toBe('task-020');
      expect(result.status).toBe('failed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Retry with Exponential Backoff (Requirement 6.5)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Retry with exponential backoff', () => {
    const payload: TreasuryOperationPayload = {
      sourceToken: 'USDC',
      destinationToken: 'EURC',
      amount: '1000',
      minOutput: '900',
      recipient: '0xRecipient',
      taskId: 'task-030',
    };

    beforeEach(() => {
      // Speed up tests by mocking sleep
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    });

    it('should retry up to 3 times on settlement failure', async () => {
      rfqClient.createTrade
        .mockRejectedValueOnce(new Error('Settlement failed'))
        .mockRejectedValueOnce(new Error('Settlement failed'))
        .mockRejectedValueOnce(new Error('Settlement failed'));

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('3 attempts');
      expect(rfqClient.createTrade).toHaveBeenCalledTimes(3);
    });

    it('should succeed on second attempt after first failure', async () => {
      rfqClient.createTrade
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce(mockTrade);

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('executed');
      expect(rfqClient.createTrade).toHaveBeenCalledTimes(2);
    });

    it('should apply exponential backoff delays (1s, 2s)', async () => {
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      rfqClient.createTrade
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce(mockTrade);

      await service.executeTreasuryOperation(payload);

      // First retry: 1000ms * 2^0 = 1000ms
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
      // Second retry: 1000ms * 2^1 = 2000ms
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 2000);
    });

    it('should check quote freshness on retry attempts', async () => {
      rfqClient.createTrade
        .mockRejectedValueOnce(new Error('Transient'))
        .mockResolvedValueOnce(mockTrade);

      await service.executeTreasuryOperation(payload);

      expect(fxRetryService.ensureFreshQuote).toHaveBeenCalledTimes(1);
      expect(fxRetryService.ensureFreshQuote).toHaveBeenCalledWith(
        mockQuote,
        {
          fromCurrency: 'USDC',
          toCurrency: 'EURC',
          fromAmount: '1000',
          tenor: 'instant',
        },
      );
    });

    it('should use fresh quote when previous quote expired on retry', async () => {
      const freshQuote: RfqQuote = {
        ...mockQuote,
        quoteId: 'fresh-quote-789',
        rate: '0.93',
        toAmount: '930',
      };

      fxRetryService.ensureFreshQuote.mockResolvedValue({
        quote: freshQuote,
        wasRefreshed: true,
        expiredQuoteId: 'quote-123',
      });

      rfqClient.createTrade
        .mockRejectedValueOnce(new Error('Transient'))
        .mockResolvedValueOnce({
          ...mockTrade,
          quoteId: 'fresh-quote-789',
        });

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('executed');
      expect(rfqClient.createTrade).toHaveBeenLastCalledWith(
        'fresh-quote-789',
        'task-030',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Confirmed Output Recording (Requirement 6.6)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Confirmed output recording (not estimated)', () => {
    const payload: TreasuryOperationPayload = {
      sourceToken: 'USDC',
      destinationToken: 'EURC',
      amount: '1000',
      minOutput: '900',
      recipient: '0xRecipient',
      taskId: 'task-040',
    };

    it('should record actual settled output, not quoted amount', async () => {
      // Quote says 920, but actual settlement is 918.50
      rfqClient.getTradeStatus.mockResolvedValue({
        tradeId: 'trade-456',
        status: 'completed',
        fromAmount: '1000',
        toAmount: '918.50', // Actual settled output
        settledAt: new Date().toISOString(),
      });

      const result = await service.executeTreasuryOperation(payload);

      // settledAmount should be the CONFIRMED output (918.50), not the quoted (920)
      expect(result.settledAmount).toBe('918.50');
      expect(result.quotedAmount).toBe('920');
      expect(result.settledAmount).not.toBe(result.quotedAmount);
    });

    it('should pass settled amount to validator, not quoted amount', async () => {
      rfqClient.getTradeStatus.mockResolvedValue({
        tradeId: 'trade-456',
        status: 'completed',
        fromAmount: '1000',
        toAmount: '915.00',
        settledAt: new Date().toISOString(),
      });

      await service.executeTreasuryOperation(payload);

      expect(settlementValidator.validateOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          settledAmount: '915.00',
          quotedAmount: '920',
        }),
      );
    });

    it('should fail when settled output is below minimum', async () => {
      rfqClient.getTradeStatus.mockResolvedValue({
        tradeId: 'trade-456',
        status: 'completed',
        fromAmount: '1000',
        toAmount: '850.00', // Below minOutput of 900
        settledAt: new Date().toISOString(),
      });

      settlementValidator.validateOutput.mockReturnValue({
        accepted: false,
        deviationPercent: 7.6,
        alertRequired: true,
        reason: 'Settlement rejected: settledAmount (850) is less than minAcceptableOutput (900)',
      });

      const result = await service.executeTreasuryOperation(payload);

      expect(result.status).toBe('failed');
      expect(result.settledAmount).toBe('850.00');
      expect(result.failureReason).toContain('less than minAcceptableOutput');
    });

    it('should store both quoted and confirmed amounts separately', async () => {
      rfqClient.getTradeStatus.mockResolvedValue({
        tradeId: 'trade-456',
        status: 'completed',
        fromAmount: '1000',
        toAmount: '919.00',
        settledAt: new Date().toISOString(),
      });

      const result = await service.executeTreasuryOperation(payload);

      // Both fields should be present and distinct
      expect(result).toHaveProperty('settledAmount', '919.00');
      expect(result).toHaveProperty('quotedAmount', '920');
    });
  });
});
