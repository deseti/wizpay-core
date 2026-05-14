import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { TaskService } from '../task/task.service';
import { QueueService } from '../queue/queue.service';
import { ExecutionRouterService } from '../execution/execution-router.service';
import { FxRoutingGuard } from '../fx/fx-routing-guard.service';
import { StableFXRfqClient } from '../fx/stablefx-rfq-client.service';
import { FxOperationPayload } from '../fx/fx.types';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';

describe('OrchestratorService — handleFxOperation', () => {
  let service: OrchestratorService;
  let taskService: jest.Mocked<TaskService>;
  let queueService: jest.Mocked<QueueService>;
  let executionRouter: jest.Mocked<ExecutionRouterService>;
  let fxRoutingGuard: jest.Mocked<FxRoutingGuard>;
  let rfqClient: jest.Mocked<StableFXRfqClient>;
  const originalLegacyFxFlag = process.env.WIZPAY_ENABLE_LEGACY_FX;

  const mockTaskDetails = {
    id: 'task-123',
    type: TaskType.FX,
    status: TaskStatus.IN_PROGRESS,
    totalUnits: 0,
    completedUnits: 0,
    failedUnits: 0,
    metadata: null,
    payload: {},
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    logs: [],
    units: [],
    transactions: [],
  };

  const validPayload: FxOperationPayload = {
    sourceToken: 'USDC',
    destinationToken: 'EURC',
    amount: '1000',
    minOutput: '900',
    recipient: '0x1234567890abcdef1234567890abcdef12345678',
    tenor: 'instant',
  };

  const mockQuote = {
    quoteId: 'quote-abc-123',
    rate: '0.92',
    fromAmount: '1000',
    toAmount: '920',
    fee: '1.5',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tenor: 'instant',
  };

  const mockTrade = {
    tradeId: 'trade-xyz-789',
    status: 'confirmed' as const,
    quoteId: 'quote-abc-123',
    fromAmount: '1000',
    toAmount: '920',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestratorService,
        {
          provide: TaskService,
          useValue: {
            createTask: jest.fn().mockResolvedValue(mockTaskDetails),
            getTaskById: jest.fn().mockResolvedValue(mockTaskDetails),
            updateStatus: jest.fn().mockResolvedValue(undefined),
            logStep: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: QueueService,
          useValue: {
            enqueueTask: jest.fn().mockResolvedValue(undefined),
            enqueueTransactionPoll: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ExecutionRouterService,
          useValue: {
            execute: jest.fn().mockResolvedValue({ agent: 'swap' }),
          },
        },
        {
          provide: FxRoutingGuard,
          useValue: {
            getActiveMode: jest.fn().mockReturnValue('new'),
            isCircuitOpen: jest.fn().mockReturnValue(false),
            recordOutcome: jest.fn(),
          },
        },
        {
          provide: StableFXRfqClient,
          useValue: {
            requestQuote: jest.fn().mockResolvedValue(mockQuote),
            createTrade: jest.fn().mockResolvedValue(mockTrade),
          },
        },
      ],
    }).compile();

    service = module.get(OrchestratorService);
    taskService = module.get(TaskService) as jest.Mocked<TaskService>;
    queueService = module.get(QueueService) as jest.Mocked<QueueService>;
    executionRouter = module.get(
      ExecutionRouterService,
    ) as jest.Mocked<ExecutionRouterService>;
    fxRoutingGuard = module.get(FxRoutingGuard) as jest.Mocked<FxRoutingGuard>;
    rfqClient = module.get(StableFXRfqClient) as jest.Mocked<StableFXRfqClient>;
  });

  afterEach(() => {
    if (originalLegacyFxFlag === undefined) {
      delete process.env.WIZPAY_ENABLE_LEGACY_FX;
    } else {
      process.env.WIZPAY_ENABLE_LEGACY_FX = originalLegacyFxFlag;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Legacy mode routing
  // ─────────────────────────────────────────────────────────────────────────────

  describe('legacy mode routing', () => {
    beforeEach(() => {
      process.env.WIZPAY_ENABLE_LEGACY_FX = 'true';
      fxRoutingGuard.getActiveMode.mockReturnValue('legacy');
    });

    it('routes to legacy swap path when mode is "legacy"', async () => {
      await service.handleFxOperation(validPayload);

      expect(fxRoutingGuard.getActiveMode).toHaveBeenCalled();
      expect(taskService.createTask).toHaveBeenCalledWith(
        TaskType.SWAP,
        expect.objectContaining({
          tokenIn: 'USDC',
          tokenOut: 'EURC',
          amountIn: '1000',
          minAmountOut: '900',
          recipient: validPayload.recipient,
          fxRoute: 'legacy',
        }),
      );
    });

    it('does not call StableFXRfqClient in legacy mode', async () => {
      await service.handleFxOperation(validPayload);

      expect(rfqClient.requestQuote).not.toHaveBeenCalled();
      expect(rfqClient.createTrade).not.toHaveBeenCalled();
    });

    it('does not check circuit breaker in legacy mode', async () => {
      await service.handleFxOperation(validPayload);

      expect(fxRoutingGuard.isCircuitOpen).not.toHaveBeenCalled();
    });

    it('logs the legacy routing path', async () => {
      await service.handleFxOperation(validPayload);

      expect(taskService.logStep).toHaveBeenCalledWith(
        mockTaskDetails.id,
        'fx.routed_legacy',
        TaskStatus.ASSIGNED,
        expect.stringContaining('legacy'),
        expect.objectContaining({
          context: expect.objectContaining({ route: 'legacy' }),
        }),
      );
    });

    it('returns task details from the created task', async () => {
      const result = await service.handleFxOperation(validPayload);

      expect(result).toEqual(mockTaskDetails);
      expect(taskService.getTaskById).toHaveBeenCalledWith(mockTaskDetails.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // New mode routing (full flow)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('new mode routing (full flow)', () => {
    beforeEach(() => {
      fxRoutingGuard.getActiveMode.mockReturnValue('new');
      fxRoutingGuard.isCircuitOpen.mockReturnValue(false);
    });

    it('requests a quote from StableFXRfqClient', async () => {
      await service.handleFxOperation(validPayload);

      expect(rfqClient.requestQuote).toHaveBeenCalledWith({
        fromCurrency: 'USDC',
        toCurrency: 'EURC',
        fromAmount: '1000',
        tenor: 'instant',
      });
    });

    it('creates a trade with the quote ID', async () => {
      await service.handleFxOperation(validPayload);

      expect(rfqClient.createTrade).toHaveBeenCalledWith(
        'quote-abc-123',
        expect.stringMatching(/^fx_/),
      );
    });

    it('enqueues a settlement poll job on tx_poll queue', async () => {
      await service.handleFxOperation(validPayload);

      expect(queueService.enqueueTransactionPoll).toHaveBeenCalledWith(
        {
          taskId: mockTaskDetails.id,
          txId: 'trade-xyz-789',
          attempt: 0,
        },
        2000,
      );
    });

    it('records a successful outcome via FxRoutingGuard', async () => {
      await service.handleFxOperation(validPayload);

      expect(fxRoutingGuard.recordOutcome).toHaveBeenCalledWith('new', true);
    });

    it('creates a task with FX type', async () => {
      await service.handleFxOperation(validPayload);

      expect(taskService.createTask).toHaveBeenCalledWith(
        TaskType.FX,
        expect.objectContaining({
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          amount: '1000',
          minOutput: '900',
          recipient: validPayload.recipient,
          fxRoute: 'new',
        }),
      );
    });

    it('logs quote_requested, quote_received, trade_created, and settlement_polling steps', async () => {
      await service.handleFxOperation(validPayload);

      const logStepCalls = taskService.logStep.mock.calls.map((c) => c[1]);
      expect(logStepCalls).toContain('fx.quote_requested');
      expect(logStepCalls).toContain('fx.quote_received');
      expect(logStepCalls).toContain('fx.trade_created');
      expect(logStepCalls).toContain('fx.settlement_polling');
    });

    it('uses default tenor "instant" when not specified', async () => {
      const payloadWithoutTenor: FxOperationPayload = {
        ...validPayload,
        tenor: undefined,
      };

      await service.handleFxOperation(payloadWithoutTenor);

      expect(rfqClient.requestQuote).toHaveBeenCalledWith(
        expect.objectContaining({ tenor: 'instant' }),
      );
    });

    it('returns task details after successful flow', async () => {
      const result = await service.handleFxOperation(validPayload);

      expect(result).toEqual(mockTaskDetails);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Circuit breaker rejection
  // ─────────────────────────────────────────────────────────────────────────────

  describe('circuit breaker rejection', () => {
    beforeEach(() => {
      fxRoutingGuard.getActiveMode.mockReturnValue('new');
      fxRoutingGuard.isCircuitOpen.mockReturnValue(true);
    });

    it('throws ServiceUnavailableException when circuit is open', async () => {
      await expect(service.handleFxOperation(validPayload)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws with message indicating circuit is open', async () => {
      await expect(service.handleFxOperation(validPayload)).rejects.toThrow(
        'FX operations halted: circuit open',
      );
    });

    it('does not request a quote when circuit is open', async () => {
      await expect(service.handleFxOperation(validPayload)).rejects.toThrow();

      expect(rfqClient.requestQuote).not.toHaveBeenCalled();
    });

    it('does not create a task when circuit is open', async () => {
      await expect(service.handleFxOperation(validPayload)).rejects.toThrow();

      expect(taskService.createTask).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Missing minOutput rejection
  // ─────────────────────────────────────────────────────────────────────────────

  describe('missing minOutput rejection', () => {
    beforeEach(() => {
      fxRoutingGuard.getActiveMode.mockReturnValue('new');
      fxRoutingGuard.isCircuitOpen.mockReturnValue(false);
    });

    it('throws BadRequestException when minOutput is empty string', async () => {
      const payload: FxOperationPayload = { ...validPayload, minOutput: '' };

      await expect(service.handleFxOperation(payload)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when minOutput is whitespace only', async () => {
      const payload: FxOperationPayload = { ...validPayload, minOutput: '   ' };

      await expect(service.handleFxOperation(payload)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws with message indicating minOutput is required', async () => {
      const payload: FxOperationPayload = { ...validPayload, minOutput: '' };

      await expect(service.handleFxOperation(payload)).rejects.toThrow(
        /[Mm]inimum output.*required/,
      );
    });

    it('does not request a quote when minOutput is missing', async () => {
      const payload: FxOperationPayload = { ...validPayload, minOutput: '' };

      await expect(service.handleFxOperation(payload)).rejects.toThrow();

      expect(rfqClient.requestQuote).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Routing path logging
  // ─────────────────────────────────────────────────────────────────────────────

  describe('routing path logging', () => {
    it('logs routing path for legacy mode operations', async () => {
      process.env.WIZPAY_ENABLE_LEGACY_FX = 'true';
      fxRoutingGuard.getActiveMode.mockReturnValue('legacy');

      // Spy on the logger
      const logSpy = jest.spyOn((service as any).logger, 'log');

      await service.handleFxOperation(validPayload);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('route=legacy'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('operationId='),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('timestamp='),
      );
    });

    it('logs routing path for new mode operations', async () => {
      fxRoutingGuard.getActiveMode.mockReturnValue('new');
      fxRoutingGuard.isCircuitOpen.mockReturnValue(false);

      const logSpy = jest.spyOn((service as any).logger, 'log');

      await service.handleFxOperation(validPayload);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('route=new'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('operationId='),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('timestamp='),
      );
    });

    it('includes source and destination tokens in the log', async () => {
      fxRoutingGuard.getActiveMode.mockReturnValue('new');
      fxRoutingGuard.isCircuitOpen.mockReturnValue(false);

      const logSpy = jest.spyOn((service as any).logger, 'log');

      await service.handleFxOperation(validPayload);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('source=USDC'),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dest=EURC'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error handling and outcome recording
  // ─────────────────────────────────────────────────────────────────────────────

  describe('error handling and outcome recording', () => {
    beforeEach(() => {
      fxRoutingGuard.getActiveMode.mockReturnValue('new');
      fxRoutingGuard.isCircuitOpen.mockReturnValue(false);
    });

    it('records failure outcome when quote request fails', async () => {
      rfqClient.requestQuote.mockRejectedValue(new Error('API timeout'));

      await expect(service.handleFxOperation(validPayload)).rejects.toThrow(
        'API timeout',
      );

      expect(fxRoutingGuard.recordOutcome).toHaveBeenCalledWith('new', false);
    });

    it('records failure outcome when trade creation fails', async () => {
      rfqClient.createTrade.mockRejectedValue(new Error('Trade rejected'));

      await expect(service.handleFxOperation(validPayload)).rejects.toThrow(
        'Trade rejected',
      );

      expect(fxRoutingGuard.recordOutcome).toHaveBeenCalledWith('new', false);
    });

    it('marks task as FAILED when an error occurs', async () => {
      rfqClient.requestQuote.mockRejectedValue(new Error('Network error'));

      await expect(service.handleFxOperation(validPayload)).rejects.toThrow();

      expect(taskService.updateStatus).toHaveBeenCalledWith(
        mockTaskDetails.id,
        TaskStatus.FAILED,
        expect.objectContaining({
          step: 'fx.settlement_failed',
          message: 'Network error',
        }),
      );
    });

    it('re-throws the original error after recording outcome', async () => {
      const originalError = new Error('Specific API failure');
      rfqClient.requestQuote.mockRejectedValue(originalError);

      await expect(service.handleFxOperation(validPayload)).rejects.toThrow(
        originalError,
      );
    });

    it('propagates FxRoutingGuard errors when mode is invalid', async () => {
      fxRoutingGuard.getActiveMode.mockImplementation(() => {
        throw new Error('FX routing configuration is unavailable');
      });

      await expect(service.handleFxOperation(validPayload)).rejects.toThrow(
        /FX routing configuration is unavailable/,
      );
    });
  });
});
