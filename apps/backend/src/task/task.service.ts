import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { PayrollBatchService } from '../agents/payroll/payroll-batch.service';
import { PayrollValidationService } from '../agents/payroll/payroll-validation.service';
import { TaskType } from './task-type.enum';
import { Prisma, Task } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskStatus } from './task-status.enum';
import {
  AppendTransactionInput,
  CreateLiquidityTaskResult,
  CreatePayrollTaskResult,
  CreateSwapTaskResult,
  ReportTaskUnitInput,
  ReportTaskUnitResult,
  TaskDetails,
  TaskLogLevel,
  TaskLogRecord,
  TaskPayload,
  TaskTransactionRecord,
  TaskUnitRecord,
  TaskUnitStatus,
  UpdateTransactionInput,
} from './task.types';
import { TaskLogService } from './task-log.service';
import { TaskTransactionService } from './task-transaction.service';
import { TaskMapperService, TaskWithRelations } from './task-mapper.service';
import { TaskUnitService } from './task-unit.service';

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TaskStatus.CREATED]: [TaskStatus.ASSIGNED, TaskStatus.FAILED],
  [TaskStatus.ASSIGNED]: [TaskStatus.IN_PROGRESS, TaskStatus.FAILED],
  [TaskStatus.IN_PROGRESS]: [
    TaskStatus.REVIEW,
    TaskStatus.EXECUTED,
    TaskStatus.PARTIAL,
    TaskStatus.FAILED,
  ],
  [TaskStatus.REVIEW]: [TaskStatus.APPROVED, TaskStatus.FAILED],
  [TaskStatus.APPROVED]: [TaskStatus.EXECUTED, TaskStatus.FAILED],
  [TaskStatus.EXECUTED]: [],
  [TaskStatus.PARTIAL]: [],
  [TaskStatus.FAILED]: [],
};

@Injectable()
export class TaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskLogService: TaskLogService,
    private readonly taskTransactionService: TaskTransactionService,
    private readonly taskMapper: TaskMapperService,
    private readonly taskUnitService: TaskUnitService,
    @Inject(forwardRef(() => PayrollValidationService))
    private readonly validationService: PayrollValidationService,
    @Inject(forwardRef(() => PayrollBatchService))
    private readonly batchService: PayrollBatchService,
  ) {}

  async createTask(type: string, payload: TaskPayload): Promise<TaskDetails> {
    const task = await this.prisma.task.create({
      data: {
        type,
        status: TaskStatus.CREATED,
        totalUnits: 0,
        completedUnits: 0,
        failedUnits: 0,
        metadata: payload as Prisma.InputJsonValue,
        payload: payload as Prisma.InputJsonValue,
      },
      include: { logs: true, units: true, transactions: true },
    });

    await this.logStep(
      task.id,
      'task.created',
      TaskStatus.CREATED,
      `Task ${type} created`,
    );

    return this.getTaskById(task.id);
  }

  async createPayrollTask(
    payload: TaskPayload,
  ): Promise<CreatePayrollTaskResult> {
    const validation = await this.validationService.validate(payload);

    if (!validation.valid) {
      throw new BadRequestException({
        code: 'PAYROLL_INIT_INVALID',
        details: validation.errors,
        error: 'Payroll init validation failed.',
      });
    }

    const batches = this.batchService.splitIntoBatches(validation.recipients);
    const totals = this.batchService.calculateTotals(batches);
    const sourceToken =
      typeof payload.sourceToken === 'string' && payload.sourceToken.trim()
        ? payload.sourceToken.trim()
        : 'USDC';
    const walletAddress =
      typeof payload.walletAddress === 'string' && payload.walletAddress.trim()
        ? payload.walletAddress.trim().toLowerCase()
        : undefined;
    const referenceId = this.normalizeReferenceId(payload.referenceId);
    const units = batches.map((batch) => ({
      type: 'batch' as const,
      index: batch.index,
      status: 'PENDING' as const,
      payload: {
        referenceId: this.getBatchReferenceId(referenceId, batch.index),
        recipientCount: batch.recipients.length,
        recipients: batch.recipients.map((recipient) => ({
          address: recipient.address,
          amount: recipient.amount,
          targetToken: recipient.targetToken,
        })),
        sourceToken,
        totalAmount: batch.totalAmount.toString(),
      },
    }));

    const task = await this.prisma.$transaction(async (tx) => {
      const createdTask = await tx.task.create({
        data: {
          type: TaskType.PAYROLL,
          status: TaskStatus.ASSIGNED,
          totalUnits: units.length,
          completedUnits: 0,
          failedUnits: 0,
          metadata: {
            approvalAmount: totals.totalAmount.toString(),
            referenceId,
            sourceToken,
            ...(walletAddress ? { walletAddress } : {}),
            totalBatches: totals.totalBatches,
            totalRecipients: totals.totalRecipients,
            totalAmount: totals.totalAmount.toString(),
          } as Prisma.InputJsonValue,
          payload: payload as Prisma.InputJsonValue,
        },
      });

      if (units.length > 0) {
        await tx.taskUnit.createMany({
          data: units.map((unit) => ({
            taskId: createdTask.id,
            type: unit.type,
            index: unit.index,
            status: unit.status,
            payload: unit.payload as Prisma.InputJsonValue,
          })),
        });
      }

      await tx.taskLog.createMany({
        data: [
          {
            taskId: createdTask.id,
            level: 'INFO',
            step: 'task.created',
            status: TaskStatus.CREATED,
            message: 'Task payroll created',
            context: {
              totalUnits: units.length,
              sourceToken,
            } as Prisma.InputJsonValue,
          },
          {
            taskId: createdTask.id,
            level: 'INFO',
            step: 'task.assigned',
            status: TaskStatus.ASSIGNED,
            message: `Prepared ${units.length} payroll batch unit(s)`,
            context: {
              referenceId,
              totalRecipients: totals.totalRecipients,
            } as Prisma.InputJsonValue,
          },
        ],
      });

      return tx.task.findUniqueOrThrow({
        where: { id: createdTask.id },
        include: { logs: true, units: true, transactions: true },
      });
    });

    return {
      taskId: task.id,
      approvalAmount: totals.totalAmount.toString(),
      referenceId,
      totalUnits: task.totalUnits,
      units: task.units
        .sort((left, right) => left.index - right.index)
        .map((unit) => ({
          id: unit.id,
          index: unit.index,
          payload: this.mapJsonObject(unit.payload),
          status: unit.status as TaskUnitStatus,
          type: unit.type as TaskUnitRecord['type'],
        })),
    };
  }

  async createSwapTask(
    payload: TaskPayload,
  ): Promise<CreateSwapTaskResult> {
    const tokenIn = typeof payload.tokenIn === 'string' ? payload.tokenIn : '';
    const tokenOut = typeof payload.tokenOut === 'string' ? payload.tokenOut : '';
    const amountIn = typeof payload.amountIn === 'string' ? payload.amountIn : '';
    const minAmountOut = typeof payload.minAmountOut === 'string' ? payload.minAmountOut : '0';
    const recipient = typeof payload.recipient === 'string' ? payload.recipient : '';

    if (!tokenIn || !tokenOut || !amountIn || !recipient) {
      throw new BadRequestException(
        'Missing required fields: tokenIn, tokenOut, amountIn, recipient',
      );
    }

    const referenceId = `SWAP-${Date.now()}`;

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          type: TaskType.SWAP,
          status: TaskStatus.ASSIGNED,
          totalUnits: 1,
          completedUnits: 0,
          failedUnits: 0,
          metadata: { referenceId, tokenIn, tokenOut, amountIn, minAmountOut, recipient } as Prisma.InputJsonValue,
          payload: payload as Prisma.InputJsonValue,
        },
      });

      await tx.taskUnit.create({
        data: {
          taskId: created.id,
          type: 'step',
          index: 0,
          status: 'PENDING',
          payload: { referenceId, tokenIn, tokenOut, amountIn, minAmountOut, recipient } as Prisma.InputJsonValue,
        },
      });

      await tx.taskLog.create({
        data: {
          taskId: created.id,
          level: 'INFO',
          step: 'task.assigned',
          status: TaskStatus.ASSIGNED,
          message: `Swap task created: ${amountIn} ${tokenIn} → ${tokenOut}`,
          context: { referenceId, tokenIn, tokenOut } as Prisma.InputJsonValue,
        },
      });

      return tx.task.findUniqueOrThrow({
        where: { id: created.id },
        include: { logs: true, units: true, transactions: true },
      });
    });

    const unit = task.units[0];

    return {
      taskId: task.id,
      unitId: unit.id,
      referenceId,
      tokenIn,
      tokenOut,
      amountIn,
      minAmountOut,
      recipient,
    };
  }

  async createLiquidityTask(
    payload: TaskPayload,
  ): Promise<CreateLiquidityTaskResult> {
    const operation = payload.operation === 'add' || payload.operation === 'remove'
      ? payload.operation
      : null;
    const token = typeof payload.token === 'string' ? payload.token : '';
    const amount = typeof payload.amount === 'string' ? payload.amount : '';

    if (!operation || !token || !amount) {
      throw new BadRequestException(
        'Missing required fields: operation (add|remove), token, amount',
      );
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          type: TaskType.LIQUIDITY,
          status: TaskStatus.ASSIGNED,
          totalUnits: 1,
          completedUnits: 0,
          failedUnits: 0,
          metadata: { operation, token, amount } as Prisma.InputJsonValue,
          payload: payload as Prisma.InputJsonValue,
        },
      });

      await tx.taskUnit.create({
        data: {
          taskId: created.id,
          type: 'step',
          index: 0,
          status: 'PENDING',
          payload: { operation, token, amount } as Prisma.InputJsonValue,
        },
      });

      await tx.taskLog.create({
        data: {
          taskId: created.id,
          level: 'INFO',
          step: 'task.assigned',
          status: TaskStatus.ASSIGNED,
          message: `Liquidity task created: ${operation} ${amount} of ${token}`,
          context: { operation, token, amount } as Prisma.InputJsonValue,
        },
      });

      return tx.task.findUniqueOrThrow({
        where: { id: created.id },
        include: { logs: true, units: true, transactions: true },
      });
    });

    const unit = task.units[0];

    return {
      taskId: task.id,
      unitId: unit.id,
      operation,
      token,
      amount,
    };
  }

  async updateStatus(
    taskId: string,
    nextStatus: TaskStatus,
    options?: {
      step?: string;
      message?: string;
      result?: TaskPayload;
    },
  ): Promise<TaskDetails> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    const currentStatus = task.status as TaskStatus;

    if (currentStatus === nextStatus) {
      return this.getTaskById(taskId);
    }

    this.ensureTransition(currentStatus, nextStatus);

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: nextStatus,
        ...(options?.result
          ? { result: options.result as Prisma.InputJsonValue }
          : {}),
      },
    });

    await this.logStep(
      taskId,
      options?.step ?? `task.${nextStatus}`,
      nextStatus,
      options?.message ?? `Task moved to ${nextStatus}`,
    );

    return this.getTaskById(taskId);
  }

  async logStep(
    taskId: string,
    step: string,
    status: string,
    message: string,
    options?: {
      level?: TaskLogLevel;
      context?: TaskPayload;
    },
  ): Promise<TaskLogRecord> {
    return this.taskLogService.logStep(taskId, step, status, message, options);
  }

  async reportUnit(
    taskId: string,
    unitId: string,
    result: ReportTaskUnitInput,
  ): Promise<ReportTaskUnitResult> {
    return this.taskUnitService.reportUnit(taskId, unitId, result);
  }

  recomputeTaskStatus(task: {
    totalUnits: number;
    completedUnits: number;
    failedUnits: number;
  }): TaskStatus {
    return this.taskUnitService.recomputeTaskStatus(task);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Transaction tracking
  // ════════════════════════════════════════════════════════════════════

  /**
   * Append a new transaction record to a task.
   * Called by PayrollAgent after each CircleService.transfer() call.
   */
  async appendTransaction(
    input: AppendTransactionInput,
  ): Promise<TaskTransactionRecord> {
    return this.taskTransactionService.appendTransaction(input);
  }

  /**
   * Update a transaction's status, txHash, errorReason, or pollAttempts.
   * Called by TransactionPollerService after each poll.
   */
  async updateTransaction(
    txId: string,
    update: UpdateTransactionInput,
  ): Promise<TaskTransactionRecord> {
    return this.taskTransactionService.updateTransaction(txId, update);
  }

  /**
   * Get all transactions for a task.
   */
  async getTaskTransactions(
    taskId: string,
  ): Promise<TaskTransactionRecord[]> {
    return this.taskTransactionService.getTaskTransactions(taskId);
  }

  /**
   * Check if all transactions for a task have reached a terminal state.
   * Returns aggregation counts + whether the task is ready for finalization.
   */
  async getTransactionAggregation(taskId: string): Promise<{
    total: number;
    completed: number;
    failed: number;
    pending: number;
    allTerminal: boolean;
    txHashes: string[];
  }> {
    return this.taskTransactionService.getTransactionAggregation(taskId);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Task retrieval
  // ════════════════════════════════════════════════════════════════════

  async getTaskById(taskId: string): Promise<TaskDetails> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        logs: {
          orderBy: { createdAt: 'asc' },
        },
        units: {
          orderBy: [{ index: 'asc' }, { createdAt: 'asc' }],
        },
        transactions: {
          orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    return this.mapTask(task);
  }

  async getTaskList(options: {
    type?: string;
    status?: string;
    walletAddress?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: TaskDetails[]; total: number }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    // Build where clause — wallet filtering matches against metadata JSON
    const where: Prisma.TaskWhereInput = {
      ...(options.type ? { type: options.type } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.walletAddress
        ? {
            OR: [
              { metadata: { path: ['walletAddress'], equals: options.walletAddress } },
              { metadata: { path: ['recipient'], equals: options.walletAddress } },
              { metadata: { path: ['destinationAddress'], equals: options.walletAddress } },
              { metadata: { path: ['sourceAddress'], equals: options.walletAddress } },
              { payload: { path: ['walletAddress'], equals: options.walletAddress } },
              { payload: { path: ['recipient'], equals: options.walletAddress } },
              { payload: { path: ['destinationAddress'], equals: options.walletAddress } },
              { payload: { path: ['sourceAddress'], equals: options.walletAddress } },
            ],
          }
        : {}),
    };

    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: {
          logs: { orderBy: { createdAt: 'asc' } },
          units: { orderBy: [{ index: 'asc' }, { createdAt: 'asc' }] },
          transactions: { orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }] },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      items: tasks.map((t) => this.mapTask(t)),
      total,
    };
  }

  async hasLogStep(taskId: string, step: string): Promise<boolean> {
    return this.taskLogService.hasLogStep(taskId, step);
  }

  private ensureTransition(currentStatus: TaskStatus, nextStatus: TaskStatus) {
    if (!ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus)) {
      throw new BadRequestException(
        `Invalid task status transition from ${currentStatus} to ${nextStatus}`,
      );
    }
  }

  private mapTask(task: TaskWithRelations): TaskDetails {
    return this.taskMapper.mapTask(task);
  }

  private normalizeReferenceId(referenceId: unknown) {
    if (typeof referenceId === 'string' && referenceId.trim()) {
      return referenceId.trim();
    }

    return `PAY-${Date.now()}`;
  }

  private getBatchReferenceId(baseReferenceId: string, batchIndex: number) {
    if (batchIndex === 0) {
      return baseReferenceId;
    }

    const matchedSuffix = baseReferenceId.match(/(.*)-(\d+)$/);

    if (matchedSuffix) {
      return `${matchedSuffix[1]}-${parseInt(matchedSuffix[2], 10) + batchIndex}`;
    }

    return `${baseReferenceId}-${batchIndex + 1}`;
  }

  private mapJsonObject(value: Prisma.JsonValue): TaskPayload {
    return this.taskMapper.mapJsonObject(value);
  }
}