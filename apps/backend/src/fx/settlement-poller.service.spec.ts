import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  SettlementPollerService,
  SettlementFailedError,
  SettlementTimeoutError,
  SettlementTradeStatus,
  TaskServicePort,
} from './settlement-poller.service';
import { SettlementValidator } from './settlement-validator.service';

describe('SettlementPollerService', () => {
  let service: SettlementPollerService;
  let taskService: jest.Mocked<TaskServicePort>;

  const TRADE_ID = 'trade-123';
  const TASK_ID = 'task-456';
  const MIN_OUTPUT = '95.0';
  const QUOTED_AMOUNT = '100.0';

  function createTradeStatus(
    status: string,
    toAmount = '100.0',
  ): SettlementTradeStatus {
    return {
      tradeId: TRADE_ID,
      status,
      fromAmount: '100.0',
      toAmount,
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
  });

  describe('Successful settlement (completed status)', () => {
    it('marks task EXECUTED when trade reaches "completed" with valid output', async () => {
      const getTradeStatus = jest
        .fn()
        .mockResolvedValue(createTradeStatus('completed', '98.5'));

      await service.pollTradeStatus(
        TRADE_ID,
        TASK_ID,
        taskService,
        MIN_OUTPUT,
        QUOTED_AMOUNT,
        getTradeStatus,
      );

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'executed',
        expect.objectContaining({ step: 'fx.settlement_confirmed' }),
      );
    });

    it('marks task FAILED when validated output is below minimum', async () => {
      const getTradeStatus = jest
        .fn()
        .mockResolvedValue(createTradeStatus('completed', '10.0'));

      await service.pollTradeStatus(
        TRADE_ID,
        TASK_ID,
        taskService,
        MIN_OUTPUT,
        QUOTED_AMOUNT,
        getTradeStatus,
      );

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'failed',
        expect.objectContaining({ step: 'fx.output_validation_failed' }),
      );
    });
  });

  describe('Terminal failure', () => {
    it('marks task FAILED and throws on terminal failure status', async () => {
      const getTradeStatus = jest
        .fn()
        .mockResolvedValue(createTradeStatus('failed', '0'));

      await expect(
        service.pollTradeStatus(
          TRADE_ID,
          TASK_ID,
          taskService,
          MIN_OUTPUT,
          QUOTED_AMOUNT,
          getTradeStatus,
        ),
      ).rejects.toBeInstanceOf(SettlementFailedError);

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        TASK_ID,
        'failed',
        expect.objectContaining({ step: 'fx.settlement_failed' }),
      );
    });
  });

  describe('Timeout', () => {
    it('marks task FAILED and throws when max attempts are exhausted', async () => {
      const getTradeStatus = jest
        .fn()
        .mockResolvedValue(createTradeStatus('pending', '0'));

      await expect(
        service.pollTradeStatus(
          TRADE_ID,
          TASK_ID,
          taskService,
          MIN_OUTPUT,
          QUOTED_AMOUNT,
          getTradeStatus,
        ),
      ).rejects.toBeInstanceOf(SettlementTimeoutError);
    });
  });

  describe('Missing status provider (fail-closed)', () => {
    it('refuses to poll without a Mainnet status provider', async () => {
      await expect(
        service.pollTradeStatus(
          TRADE_ID,
          TASK_ID,
          taskService,
          MIN_OUTPUT,
          QUOTED_AMOUNT,
        ),
      ).rejects.toMatchObject({
        response: { code: 'SETTLEMENT_POLL_UNAVAILABLE' },
      });

      expect(taskService.updateStatus).not.toHaveBeenCalled();
    });
  });
});
