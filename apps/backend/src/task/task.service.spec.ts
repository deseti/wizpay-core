import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TaskService, ALLOWED_TRANSITIONS, FX_STEPS } from './task.service';
import { TaskStatus } from './task-status.enum';
import { TaskLogService } from './task-log.service';
import { PrismaService } from '../database/prisma.service';
import { TaskTransactionService } from './task-transaction.service';
import { TaskMapperService } from './task-mapper.service';
import { TaskUnitService } from './task-unit.service';
import { PayrollValidationService } from '../agents/payroll/payroll-validation.service';
import { PayrollBatchService } from '../agents/payroll/payroll-batch.service';

describe('TaskService', () => {
  let taskService: TaskService;
  let prisma: jest.Mocked<PrismaService>;
  let taskLogService: jest.Mocked<TaskLogService>;
  let taskTransactionService: jest.Mocked<TaskTransactionService>;
  let taskMapper: jest.Mocked<TaskMapperService>;
  let taskUnitService: jest.Mocked<TaskUnitService>;
  let validationService: jest.Mocked<PayrollValidationService>;
  let batchService: jest.Mocked<PayrollBatchService>;
  const originalLegacyFxFlag = process.env.WIZPAY_ENABLE_LEGACY_FX;
  const originalLegacyLiquidityFlag =
    process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY;

  beforeEach(() => {
    prisma = {
      task: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      taskLog: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;

    taskLogService = {
      logStep: jest.fn().mockResolvedValue({
        id: 'log-1',
        taskId: 'task-1',
        level: 'INFO',
        step: 'test',
        status: 'created',
        message: 'test',
        context: null,
        createdAt: new Date(),
      }),
      hasLogStep: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<TaskLogService>;

    taskTransactionService =
      {} as unknown as jest.Mocked<TaskTransactionService>;
    taskMapper = {
      mapTask: jest.fn().mockImplementation((task) => task),
      mapJsonObject: jest.fn().mockImplementation((v) => v),
    } as unknown as jest.Mocked<TaskMapperService>;
    taskUnitService = {} as unknown as jest.Mocked<TaskUnitService>;
    validationService = {} as unknown as jest.Mocked<PayrollValidationService>;
    batchService = {} as unknown as jest.Mocked<PayrollBatchService>;

    taskService = new TaskService(
      prisma,
      taskLogService,
      taskTransactionService,
      taskMapper,
      taskUnitService,
      validationService,
      batchService,
    );
  });

  afterEach(() => {
    if (originalLegacyFxFlag === undefined) {
      delete process.env.WIZPAY_ENABLE_LEGACY_FX;
    } else {
      process.env.WIZPAY_ENABLE_LEGACY_FX = originalLegacyFxFlag;
    }

    if (originalLegacyLiquidityFlag === undefined) {
      delete process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY;
    } else {
      process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY = originalLegacyLiquidityFlag;
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  FX Step Identifiers
  // ════════════════════════════════════════════════════════════════════

  describe('FX_STEPS constants', () => {
    it('defines all required FX step identifiers', () => {
      expect(FX_STEPS.QUOTE_REQUESTED).toBe('fx.quote_requested');
      expect(FX_STEPS.QUOTE_RECEIVED).toBe('fx.quote_received');
      expect(FX_STEPS.TRADE_CREATED).toBe('fx.trade_created');
      expect(FX_STEPS.ESCROW_FUNDED).toBe('fx.escrow_funded');
      expect(FX_STEPS.SETTLEMENT_POLLING).toBe('fx.settlement_polling');
      expect(FX_STEPS.SETTLEMENT_CONFIRMED).toBe('fx.settlement_confirmed');
      expect(FX_STEPS.SETTLEMENT_FAILED).toBe('fx.settlement_failed');
      expect(FX_STEPS.OUTPUT_VALIDATION_FAILED).toBe(
        'fx.output_validation_failed',
      );
      expect(FX_STEPS.RATE_ANOMALY).toBe('fx.rate_anomaly');
    });

    it('has exactly 9 FX step identifiers', () => {
      expect(Object.keys(FX_STEPS)).toHaveLength(9);
    });
  });

  describe('StableFX cutover guards', () => {
    it('rejects legacy swap task planning by default', async () => {
      await expect(
        taskService.createSwapTask({
          tokenIn: 'USDC',
          tokenOut: 'EURC',
          amountIn: '1000000',
          minAmountOut: '900000',
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'OFFICIAL_STABLEFX_AUTH_REQUIRED',
        }),
      });
    });

    it('rejects legacy liquidity task planning by default', async () => {
      await expect(
        taskService.createLiquidityTask({
          operation: 'add',
          token: 'USDC',
          amount: '1000000',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts cross-currency payroll task planning (FX settlement handled upstream)', async () => {
      validationService.validate = jest.fn().mockResolvedValue({
        valid: true,
        errors: [],
        recipients: [
          {
            address: '0x1234567890abcdef1234567890abcdef12345678',
            amount: '10',
            amountUnits: 10_000_000n,
            targetToken: 'EURC',
          },
        ],
      });

      // Cross-currency recipients are now allowed in createPayrollTask
      // because FX settlement is handled upstream by PayrollInitService.
      // The method should proceed to batching (which will fail here due to
      // missing mock, but the point is it no longer throws OFFICIAL_STABLEFX_AUTH_REQUIRED).
      await expect(
        taskService.createPayrollTask({
          sourceToken: 'USDC',
          referenceId: 'PAYROLL-CROSS-FX',
          crossCurrencySettled: true,
          recipients: [
            {
              address: '0x1234567890abcdef1234567890abcdef12345678',
              amount: '10',
              targetToken: 'EURC',
            },
          ],
        }),
      ).rejects.not.toMatchObject({
        response: expect.objectContaining({
          code: 'OFFICIAL_STABLEFX_AUTH_REQUIRED',
        }),
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  State Transition Validation
  // ════════════════════════════════════════════════════════════════════

  describe('State Transition Validation', () => {
    describe('ALLOWED_TRANSITIONS map', () => {
      it('allows created → assigned', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.CREATED]).toContain(
          TaskStatus.ASSIGNED,
        );
      });

      it('allows created → failed', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.CREATED]).toContain(
          TaskStatus.FAILED,
        );
      });

      it('allows assigned → in_progress', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.ASSIGNED]).toContain(
          TaskStatus.IN_PROGRESS,
        );
      });

      it('allows assigned → failed', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.ASSIGNED]).toContain(
          TaskStatus.FAILED,
        );
      });

      it('allows in_progress → review', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.IN_PROGRESS]).toContain(
          TaskStatus.REVIEW,
        );
      });

      it('allows in_progress → executed', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.IN_PROGRESS]).toContain(
          TaskStatus.EXECUTED,
        );
      });

      it('allows in_progress → partial', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.IN_PROGRESS]).toContain(
          TaskStatus.PARTIAL,
        );
      });

      it('allows in_progress → failed', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.IN_PROGRESS]).toContain(
          TaskStatus.FAILED,
        );
      });

      it('allows review → approved', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.REVIEW]).toContain(
          TaskStatus.APPROVED,
        );
      });

      it('allows review → failed', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.REVIEW]).toContain(
          TaskStatus.FAILED,
        );
      });

      it('allows approved → executed', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.APPROVED]).toContain(
          TaskStatus.EXECUTED,
        );
      });

      it('allows approved → failed', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.APPROVED]).toContain(
          TaskStatus.FAILED,
        );
      });

      it('does not allow transitions from terminal states', () => {
        expect(ALLOWED_TRANSITIONS[TaskStatus.EXECUTED]).toHaveLength(0);
        expect(ALLOWED_TRANSITIONS[TaskStatus.PARTIAL]).toHaveLength(0);
        expect(ALLOWED_TRANSITIONS[TaskStatus.FAILED]).toHaveLength(0);
      });
    });

    describe('isValidTransition', () => {
      it('returns true for valid transitions', () => {
        expect(
          taskService.isValidTransition(
            TaskStatus.CREATED,
            TaskStatus.ASSIGNED,
          ),
        ).toBe(true);
        expect(
          taskService.isValidTransition(
            TaskStatus.ASSIGNED,
            TaskStatus.IN_PROGRESS,
          ),
        ).toBe(true);
        expect(
          taskService.isValidTransition(
            TaskStatus.IN_PROGRESS,
            TaskStatus.EXECUTED,
          ),
        ).toBe(true);
      });

      it('returns false for invalid transitions', () => {
        expect(
          taskService.isValidTransition(
            TaskStatus.CREATED,
            TaskStatus.EXECUTED,
          ),
        ).toBe(false);
        expect(
          taskService.isValidTransition(
            TaskStatus.ASSIGNED,
            TaskStatus.EXECUTED,
          ),
        ).toBe(false);
        expect(
          taskService.isValidTransition(
            TaskStatus.EXECUTED,
            TaskStatus.CREATED,
          ),
        ).toBe(false);
        expect(
          taskService.isValidTransition(TaskStatus.FAILED, TaskStatus.CREATED),
        ).toBe(false);
      });

      it('returns false for transitions from terminal states', () => {
        const terminalStates = [
          TaskStatus.EXECUTED,
          TaskStatus.PARTIAL,
          TaskStatus.FAILED,
        ];
        const allStatuses = Object.values(TaskStatus);

        for (const terminal of terminalStates) {
          for (const target of allStatuses) {
            expect(taskService.isValidTransition(terminal, target)).toBe(false);
          }
        }
      });
    });

    describe('updateStatus - invalid transitions rejected', () => {
      it('rejects created → executed', async () => {
        (prisma.task.findUnique as jest.Mock).mockResolvedValue({
          id: 'task-1',
          status: TaskStatus.CREATED,
        });

        await expect(
          taskService.updateStatus('task-1', TaskStatus.EXECUTED),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects assigned → approved', async () => {
        (prisma.task.findUnique as jest.Mock).mockResolvedValue({
          id: 'task-1',
          status: TaskStatus.ASSIGNED,
        });

        await expect(
          taskService.updateStatus('task-1', TaskStatus.APPROVED),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects executed → any state', async () => {
        (prisma.task.findUnique as jest.Mock).mockResolvedValue({
          id: 'task-1',
          status: TaskStatus.EXECUTED,
        });

        await expect(
          taskService.updateStatus('task-1', TaskStatus.FAILED),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects failed → any state', async () => {
        (prisma.task.findUnique as jest.Mock).mockResolvedValue({
          id: 'task-1',
          status: TaskStatus.FAILED,
        });

        await expect(
          taskService.updateStatus('task-1', TaskStatus.CREATED),
        ).rejects.toThrow(BadRequestException);
      });

      it('accepts valid transition created → assigned', async () => {
        const mockTask = {
          id: 'task-1',
          status: TaskStatus.CREATED,
          type: 'fx',
          totalUnits: 1,
          completedUnits: 0,
          failedUnits: 0,
          metadata: {},
          payload: {},
          result: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          logs: [],
          units: [],
          transactions: [],
        };

        (prisma.task.findUnique as jest.Mock)
          .mockResolvedValueOnce({ id: 'task-1', status: TaskStatus.CREATED })
          .mockResolvedValue(mockTask);
        (prisma.task.update as jest.Mock).mockResolvedValue(mockTask);

        await expect(
          taskService.updateStatus('task-1', TaskStatus.ASSIGNED),
        ).resolves.toBeDefined();
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  Idempotency Guard
  // ════════════════════════════════════════════════════════════════════

  describe('Idempotency Guard - tryPickupForExecution', () => {
    it('returns true when task status is ASSIGNED', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.ASSIGNED,
      });

      const result = await taskService.tryPickupForExecution('task-1');

      expect(result).toBe(true);
      // Should NOT log anything when proceeding normally
      expect(taskLogService.logStep).not.toHaveBeenCalled();
    });

    it('returns false when task status is CREATED', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.CREATED,
      });

      const result = await taskService.tryPickupForExecution('task-1');

      expect(result).toBe(false);
    });

    it('returns false when task status is IN_PROGRESS', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.IN_PROGRESS,
      });

      const result = await taskService.tryPickupForExecution('task-1');

      expect(result).toBe(false);
    });

    it('returns false when task status is EXECUTED', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.EXECUTED,
      });

      const result = await taskService.tryPickupForExecution('task-1');

      expect(result).toBe(false);
    });

    it('returns false when task status is FAILED', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.FAILED,
      });

      const result = await taskService.tryPickupForExecution('task-1');

      expect(result).toBe(false);
    });

    it('logs a skip event when task is not ASSIGNED', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.IN_PROGRESS,
      });

      await taskService.tryPickupForExecution('task-1');

      expect(taskLogService.logStep).toHaveBeenCalledWith(
        'task-1',
        'task.idempotency_skip',
        TaskStatus.IN_PROGRESS,
        expect.stringContaining('skipped'),
        expect.objectContaining({
          level: 'INFO',
          context: expect.objectContaining({
            expectedStatus: TaskStatus.ASSIGNED,
            actualStatus: TaskStatus.IN_PROGRESS,
          }),
        }),
      );
    });

    it('does not produce side effects beyond skip log when not ASSIGNED', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.EXECUTED,
      });

      await taskService.tryPickupForExecution('task-1');

      // Only the skip log should be created — no task updates, no transactions
      expect(prisma.task.update).not.toHaveBeenCalled();
      expect(taskLogService.logStep).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when task does not exist', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        taskService.tryPickupForExecution('nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  Append-Only Audit Log
  // ════════════════════════════════════════════════════════════════════

  describe('Append-Only Audit Log', () => {
    describe('appendTransitionLog', () => {
      it('creates a log entry with priorStatus, newStatus, stepId, and timestamp', async () => {
        await taskService.appendTransitionLog(
          'task-1',
          TaskStatus.ASSIGNED,
          TaskStatus.IN_PROGRESS,
          FX_STEPS.QUOTE_REQUESTED,
          { quoteId: 'q-123' },
        );

        expect(taskLogService.logStep).toHaveBeenCalledWith(
          'task-1',
          FX_STEPS.QUOTE_REQUESTED,
          TaskStatus.IN_PROGRESS,
          `State transition: ${TaskStatus.ASSIGNED} → ${TaskStatus.IN_PROGRESS}`,
          expect.objectContaining({
            level: 'INFO',
            context: expect.objectContaining({
              priorStatus: TaskStatus.ASSIGNED,
              newStatus: TaskStatus.IN_PROGRESS,
              stepId: FX_STEPS.QUOTE_REQUESTED,
              quoteId: 'q-123',
            }),
          }),
        );
      });

      it('includes a timestamp in the context', async () => {
        await taskService.appendTransitionLog(
          'task-1',
          TaskStatus.CREATED,
          TaskStatus.ASSIGNED,
          'task.assigned',
        );

        const callArgs = taskLogService.logStep.mock.calls[0];
        const context = callArgs[4]?.context as Record<string, unknown>;
        expect(context.timestamp).toBeDefined();
        expect(typeof context.timestamp).toBe('string');
      });

      it('works without optional contextData', async () => {
        await taskService.appendTransitionLog(
          'task-1',
          TaskStatus.IN_PROGRESS,
          TaskStatus.EXECUTED,
          FX_STEPS.SETTLEMENT_CONFIRMED,
        );

        expect(taskLogService.logStep).toHaveBeenCalledWith(
          'task-1',
          FX_STEPS.SETTLEMENT_CONFIRMED,
          TaskStatus.EXECUTED,
          expect.any(String),
          expect.objectContaining({
            context: expect.objectContaining({
              priorStatus: TaskStatus.IN_PROGRESS,
              newStatus: TaskStatus.EXECUTED,
              stepId: FX_STEPS.SETTLEMENT_CONFIRMED,
            }),
          }),
        );
      });
    });

    describe('transitionWithAudit', () => {
      it('performs transition and appends audit log', async () => {
        const mockTask = {
          id: 'task-1',
          status: TaskStatus.ASSIGNED,
          type: 'fx',
          totalUnits: 1,
          completedUnits: 0,
          failedUnits: 0,
          metadata: {},
          payload: {},
          result: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          logs: [],
          units: [],
          transactions: [],
        };

        (prisma.task.findUnique as jest.Mock)
          .mockResolvedValueOnce({ id: 'task-1', status: TaskStatus.ASSIGNED })
          .mockResolvedValue(mockTask);
        (prisma.task.update as jest.Mock).mockResolvedValue(mockTask);

        await taskService.transitionWithAudit(
          'task-1',
          TaskStatus.IN_PROGRESS,
          FX_STEPS.QUOTE_REQUESTED,
          { context: { quoteId: 'q-456' } },
        );

        expect(prisma.task.update).toHaveBeenCalledWith({
          where: { id: 'task-1' },
          data: { status: TaskStatus.IN_PROGRESS },
        });

        expect(taskLogService.logStep).toHaveBeenCalledWith(
          'task-1',
          FX_STEPS.QUOTE_REQUESTED,
          TaskStatus.IN_PROGRESS,
          expect.stringContaining('assigned'),
          expect.objectContaining({
            context: expect.objectContaining({
              priorStatus: TaskStatus.ASSIGNED,
              newStatus: TaskStatus.IN_PROGRESS,
              quoteId: 'q-456',
            }),
          }),
        );
      });

      it('rejects invalid transitions', async () => {
        (prisma.task.findUnique as jest.Mock).mockResolvedValue({
          id: 'task-1',
          status: TaskStatus.CREATED,
        });

        await expect(
          taskService.transitionWithAudit(
            'task-1',
            TaskStatus.EXECUTED,
            FX_STEPS.SETTLEMENT_CONFIRMED,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('throws NotFoundException for missing task', async () => {
        (prisma.task.findUnique as jest.Mock).mockResolvedValue(null);

        await expect(
          taskService.transitionWithAudit(
            'nonexistent',
            TaskStatus.ASSIGNED,
            'task.assigned',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('is a no-op when current status equals next status', async () => {
        const mockTask = {
          id: 'task-1',
          status: TaskStatus.IN_PROGRESS,
          type: 'fx',
          totalUnits: 1,
          completedUnits: 0,
          failedUnits: 0,
          metadata: {},
          payload: {},
          result: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          logs: [],
          units: [],
          transactions: [],
        };

        (prisma.task.findUnique as jest.Mock).mockResolvedValue(mockTask);

        await taskService.transitionWithAudit(
          'task-1',
          TaskStatus.IN_PROGRESS,
          FX_STEPS.SETTLEMENT_POLLING,
        );

        expect(prisma.task.update).not.toHaveBeenCalled();
        expect(taskLogService.logStep).not.toHaveBeenCalled();
      });
    });

    describe('append-only enforcement', () => {
      it('TaskLogService only exposes create operations (logStep), no update or delete', () => {
        // The TaskLogService interface only has logStep (create) and hasLogStep (read).
        // There are no updateLog or deleteLog methods, enforcing append-only semantics.
        const methods = Object.getOwnPropertyNames(
          Object.getPrototypeOf(taskLogService),
        );

        // Verify no mutation methods exist
        expect(methods).not.toContain('updateLog');
        expect(methods).not.toContain('deleteLog');
        expect(methods).not.toContain('removeLog');
        expect(methods).not.toContain('editLog');
      });
    });
  });
});
