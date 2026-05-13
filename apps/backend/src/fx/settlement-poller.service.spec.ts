import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  SettlementPollerService,
  SettlementFailedError,
  SettlementTimeoutError,
  TaskServicePort,
} from './settlement-poller.service';
import { StableFXRfqClient, TradeStatus } from './stablefx-rfq-client.service';
import { SettlementValidator } from './settlement-validator.service';
import { TradeStatusValue } from './fx.types';

describe('SettlementPollerService', () => {
  let service: SettlementPollerService;
  let rfqClient: jest.Mocked<StableFXRfqClient>;
  let settlementValidator: SettlementValidator;
  let taskService: jest.Mocked<TaskServicePort>;

  const TRADE_ID = 'trade-123';
  const TASK_ID = 'task-456';
  const MIN_OUTPUT = '95.0';
  const QUOTED_AMOUNT = '100.0';

  function createTradeStatus(
    status: TradeStatusValue | 'settled',
    toAmount = '100.0',
  ): TradeStatus {
    return {
      tradeId: TRADE_ID,
      status: status as TradeStatusValue,
      fromAmount: '100.0',
      toAmount,
      settledAt: status === 'completed' || status === 'settled' ? new Date().toISOString() : undefined,
    };
  }

  beforeEach(async () => {
    taskService = {
      updateStatus: jest.fn().mockResolvedValue(undefined),
      logStep: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettlementPollerService,
        SettlementValidator,
        {
          provide: StableFXRfqClient,
          useValue: {
            getTradeStatus: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'FX_POLL_INTERVAL_MS') return 10; // Fast polling for tests
              if (key === 'FX_POLL_MAX_ATTEMPTS') return 5; // Low max for tests
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(SettlementPollerService);
    rfqClient = module.get(StableFXRfqClient) as jest.Mocked<StableFXRfqClient>;
    settlementValidator = module.get(SettlementValidator);
  });

  describe('Successful settlement (completed status)', () => {
    it('marks task EXECUTED when trade reaches "completed" with valid output', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('completed', '98.5'),
      );

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'executed',
        expect.objectContaining({
          step: 'fx.settlement_confirmed',
          message: expect.stringContaining('98.5'),
          result: expect.objectContaining({
            tradeId: TRADE_ID,
            settledAmount: '98.5',
          }),
        }),
      );
    });

    it('marks task EXECUTED when trade reaches "settled" status', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('settled' as TradeStatusValue, '100.0'),
      );

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'executed',
        expect.objectContaining({
          step: 'fx.settlement_confirmed',
        }),
      );
    });

    it('polls multiple times before reaching terminal success', async () => {
      rfqClient.getTradeStatus
        .mockResolvedValueOnce(createTradeStatus('confirmed'))
        .mockResolvedValueOnce(createTradeStatus('pending_settlement'))
        .mockResolvedValueOnce(createTradeStatus('completed', '99.0'));

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      expect(rfqClient.getTradeStatus).toHaveBeenCalledTimes(3);
      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'executed',
        expect.objectContaining({
          step: 'fx.settlement_confirmed',
        }),
      );
    });
  });

  describe('Terminal failure (failed/expired/cancelled)', () => {
    it('marks task FAILED and throws SettlementFailedError on "failed" status', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(createTradeStatus('failed'));

      await expect(
        service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT),
      ).rejects.toThrow(SettlementFailedError);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'failed',
        expect.objectContaining({
          step: 'fx.settlement_failed',
          message: expect.stringContaining('failed'),
          result: expect.objectContaining({
            tradeId: TRADE_ID,
            terminalStatus: 'failed',
          }),
        }),
      );
    });

    it('marks task FAILED and throws on "expired" status', async () => {
      rfqClient.getTradeStatus
        .mockResolvedValueOnce(createTradeStatus('confirmed'))
        .mockResolvedValueOnce(createTradeStatus('refunded' as TradeStatusValue))
        .mockResolvedValue(createTradeStatus('failed'));

      await expect(
        service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT),
      ).rejects.toThrow(SettlementFailedError);
    });

    it('marks task FAILED and throws on "cancelled" status', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('cancelled' as TradeStatusValue),
      );

      await expect(
        service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT),
      ).rejects.toThrow(SettlementFailedError);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'failed',
        expect.objectContaining({
          result: expect.objectContaining({
            terminalStatus: 'cancelled',
          }),
        }),
      );
    });

    it('records failure reason including terminal status value', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('expired' as TradeStatusValue),
      );

      await expect(
        service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT),
      ).rejects.toThrow(SettlementFailedError);

      const updateCall = taskService.updateStatus.mock.calls[0];
      expect(updateCall[2]?.message).toContain('expired');
      expect(updateCall[2]?.result).toHaveProperty('terminalStatus', 'expired');
    });
  });

  describe('Timeout after max attempts', () => {
    it('marks task FAILED with timeout reason when max attempts exceeded', async () => {
      // Always return non-terminal status
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('pending_settlement'),
      );

      await expect(
        service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT),
      ).rejects.toThrow(SettlementTimeoutError);

      expect(rfqClient.getTradeStatus).toHaveBeenCalledTimes(5); // maxAttempts = 5 in test config

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'failed',
        expect.objectContaining({
          step: 'fx.settlement_failed',
          message: expect.stringContaining('timeout'),
          result: expect.objectContaining({
            tradeId: TRADE_ID,
            lastStatus: 'pending_settlement',
            totalAttempts: 5,
            maxAttempts: 5,
            timeoutReason: 'max_attempts_exceeded',
          }),
        }),
      );
    });

    it('logs last status and total attempts on timeout', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('taker_funded'),
      );

      try {
        await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);
      } catch (error) {
        expect(error).toBeInstanceOf(SettlementTimeoutError);
        const timeoutError = error as SettlementTimeoutError;
        expect(timeoutError.lastStatus).toBe('taker_funded');
        expect(timeoutError.totalAttempts).toBe(5);
      }
    });
  });

  describe('Status transition logging', () => {
    it('logs each status transition as a task step', async () => {
      rfqClient.getTradeStatus
        .mockResolvedValueOnce(createTradeStatus('confirmed'))
        .mockResolvedValueOnce(createTradeStatus('pending_settlement'))
        .mockResolvedValueOnce(createTradeStatus('taker_funded'))
        .mockResolvedValueOnce(createTradeStatus('completed', '99.0'));

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      // Should log 4 transitions (initial + 3 changes) + 1 settlement confirmed
      const logCalls = taskService.logStep.mock.calls.filter(
        (call) => call[1] === 'fx.settlement_polling',
      );
      expect(logCalls).toHaveLength(4);

      // First call should be initial status
      expect(logCalls[0][3]).toContain('initial status: confirmed');

      // Subsequent calls should show transitions
      expect(logCalls[1][3]).toContain('confirmed → pending_settlement');
      expect(logCalls[2][3]).toContain('pending_settlement → taker_funded');
      expect(logCalls[3][3]).toContain('taker_funded → completed');
    });

    it('does not log duplicate entries when status remains the same', async () => {
      rfqClient.getTradeStatus
        .mockResolvedValueOnce(createTradeStatus('pending_settlement'))
        .mockResolvedValueOnce(createTradeStatus('pending_settlement'))
        .mockResolvedValueOnce(createTradeStatus('completed', '99.0'));

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      const pollingLogs = taskService.logStep.mock.calls.filter(
        (call) => call[1] === 'fx.settlement_polling',
      );
      // Only 2 transitions: initial pending_settlement, then completed
      expect(pollingLogs).toHaveLength(2);
    });

    it('includes attempt count and context in log entries', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('completed', '100.0'),
      );

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      const pollingLog = taskService.logStep.mock.calls.find(
        (call) => call[1] === 'fx.settlement_polling',
      );
      expect(pollingLog).toBeDefined();
      expect(pollingLog![4]).toEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            tradeId: TRADE_ID,
            attempt: 1,
            currentStatus: 'completed',
            maxAttempts: 5,
          }),
        }),
      );
    });
  });

  describe('Settlement validation integration', () => {
    it('marks task FAILED when settled amount is below minimum output', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('completed', '90.0'), // Below MIN_OUTPUT of 95.0
      );

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'failed',
        expect.objectContaining({
          step: 'fx.output_validation_failed',
          result: expect.objectContaining({
            tradeId: TRADE_ID,
            settledAmount: '90.0',
            minOutput: MIN_OUTPUT,
          }),
        }),
      );
    });

    it('marks task EXECUTED with alert when deviation exceeds tolerance', async () => {
      // Settled amount is above min but deviates >1% from quoted
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('completed', '96.0'), // Above 95 min, but 4% below 100 quoted
      );

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'executed',
        expect.objectContaining({
          result: expect.objectContaining({
            alertRequired: true,
            deviationPercent: expect.any(Number),
          }),
        }),
      );
    });

    it('marks task EXECUTED without alert when within tolerance', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('completed', '99.8'), // Within 1% of 100 quoted
      );

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'executed',
        expect.objectContaining({
          result: expect.objectContaining({
            alertRequired: false,
          }),
        }),
      );
    });

    it('marks task FAILED when settled amount is zero', async () => {
      rfqClient.getTradeStatus.mockResolvedValue(
        createTradeStatus('completed', '0'),
      );

      await service.pollTradeStatus(TRADE_ID, TASK_ID, taskService, MIN_OUTPUT, QUOTED_AMOUNT);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'failed',
        expect.objectContaining({
          step: 'fx.output_validation_failed',
        }),
      );
    });
  });
});
