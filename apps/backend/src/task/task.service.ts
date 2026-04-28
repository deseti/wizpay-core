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
import { Prisma, Task, TaskLog, TaskTransaction, TaskUnit } from '@prisma/client';
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
  TxStatus,
  UpdateTransactionInput,
} from './task.types';

type TaskWithRelations = Task & {
  logs: TaskLog[];
  units: TaskUnit[];
  transactions: TaskTransaction[];
};

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
    const log = await this.prisma.taskLog.create({
      data: {
        taskId,
        level: options?.level ?? 'INFO',
        step,
        status,
        message,
        ...(options?.context
          ? { context: options.context as Prisma.InputJsonValue }
          : {}),
      },
    });

    return {
      id: log.id,
      taskId: log.taskId,
      level: log.level as TaskLogLevel,
      step: log.step,
      status: log.status,
      message: log.message,
      context: log.context ? this.mapJsonObject(log.context) : null,
      createdAt: log.createdAt,
    };
  }

  async reportUnit(
    taskId: string,
    unitId: string,
    result: ReportTaskUnitInput,
  ): Promise<ReportTaskUnitResult> {
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.taskUnit.findFirst({
        where: { id: unitId, taskId },
      });

      if (!unit) {
        throw new NotFoundException(
          `Task unit ${unitId} for task ${taskId} not found`,
        );
      }

      if (unit.status !== 'PENDING') {
        const task = await this.getTaskDetailsInTransaction(tx, taskId);
        return {
          task,
          unit: this.mapUnit(unit),
          nextUnit: this.findNextPendingUnit(task),
        };
      }

      const updatedUnit = await tx.taskUnit.update({
        where: { id: unit.id },
        data: {
          status: result.status,
          ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      });

      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
      });

      const updatedTask = await tx.task.update({
        where: { id: taskId },
        data: {
          completedUnits:
            result.status === 'SUCCESS'
              ? { increment: 1 }
              : undefined,
          failedUnits:
            result.status === 'FAILED'
              ? { increment: 1 }
              : undefined,
        },
      });

      const nextStatus = this.recomputeTaskStatus({
        ...task,
        completedUnits:
          result.status === 'SUCCESS'
            ? task.completedUnits + 1
            : task.completedUnits,
        failedUnits:
          result.status === 'FAILED'
            ? task.failedUnits + 1
            : task.failedUnits,
      });

      await tx.task.update({
        where: { id: taskId },
        data: { status: nextStatus },
      });

      await tx.taskLog.create({
        data: {
          taskId,
          level: result.status === 'FAILED' ? 'ERROR' : 'INFO',
          step: 'unit.reported',
          status: nextStatus,
          message:
            result.status === 'SUCCESS'
              ? `Unit ${updatedUnit.index + 1} reported success`
              : `Unit ${updatedUnit.index + 1} reported failure`,
          context: {
            error: result.error ?? null,
            txHash: result.txHash ?? null,
            unitId: updatedUnit.id,
            unitIndex: updatedUnit.index,
            unitStatus: result.status,
          } as Prisma.InputJsonValue,
        },
      });

      const fullTask = await this.getTaskDetailsInTransaction(tx, taskId);

      return {
        task: fullTask,
        unit: this.mapUnit(updatedUnit),
        nextUnit: this.findNextPendingUnit(fullTask),
      };
    });
  }

  recomputeTaskStatus(task: {
    totalUnits: number;
    completedUnits: number;
    failedUnits: number;
  }): TaskStatus {
    if (task.failedUnits > 0) {
      return TaskStatus.REVIEW;
    }

    if (task.totalUnits > 0 && task.completedUnits === task.totalUnits) {
      return TaskStatus.EXECUTED;
    }

    return TaskStatus.IN_PROGRESS;
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
    const tx = await this.prisma.taskTransaction.create({
      data: {
        taskId: input.taskId,
        txId: input.txId,
        recipient: input.recipient,
        amount: input.amount,
        currency: input.currency,
        batchIndex: input.batchIndex,
        status: 'pending',
      },
    });

    return this.mapTransaction(tx);
  }

  /**
   * Update a transaction's status, txHash, errorReason, or pollAttempts.
   * Called by TransactionPollerService after each poll.
   */
  async updateTransaction(
    txId: string,
    update: UpdateTransactionInput,
  ): Promise<TaskTransactionRecord> {
    const existing = await this.prisma.taskTransaction.findFirst({
      where: { txId },
    });

    if (!existing) {
      throw new NotFoundException(`Transaction ${txId} not found`);
    }

    const tx = await this.prisma.taskTransaction.update({
      where: { id: existing.id },
      data: {
        status: update.status,
        ...(update.txHash !== undefined ? { txHash: update.txHash } : {}),
        ...(update.errorReason !== undefined
          ? { errorReason: update.errorReason }
          : {}),
        ...(update.pollAttempts !== undefined
          ? { pollAttempts: update.pollAttempts }
          : {}),
      },
    });

    return this.mapTransaction(tx);
  }

  /**
   * Get all transactions for a task.
   */
  async getTaskTransactions(
    taskId: string,
  ): Promise<TaskTransactionRecord[]> {
    const txs = await this.prisma.taskTransaction.findMany({
      where: { taskId },
      orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }],
    });

    return txs.map((tx) => this.mapTransaction(tx));
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
    const txs = await this.prisma.taskTransaction.findMany({
      where: { taskId },
      select: { status: true, txHash: true },
    });

    const total = txs.length;
    const completed = txs.filter((tx) => tx.status === 'completed').length;
    const failed = txs.filter((tx) => tx.status === 'failed').length;
    const pending = total - completed - failed;
    const txHashes = txs
      .filter((tx) => tx.txHash != null)
      .map((tx) => tx.txHash as string);

    return {
      total,
      completed,
      failed,
      pending,
      allTerminal: pending === 0 && total > 0,
      txHashes,
    };
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

  async hasLogStep(taskId: string, step: string): Promise<boolean> {
    const existingLog = await this.prisma.taskLog.findFirst({
      where: { taskId, step },
      select: { id: true },
    });

    return existingLog != null;
  }

  private ensureTransition(currentStatus: TaskStatus, nextStatus: TaskStatus) {
    if (!ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus)) {
      throw new BadRequestException(
        `Invalid task status transition from ${currentStatus} to ${nextStatus}`,
      );
    }
  }

  private mapTask(task: TaskWithRelations): TaskDetails {
    return {
      id: task.id,
      type: task.type,
      status: task.status,
      totalUnits: task.totalUnits,
      completedUnits: task.completedUnits,
      failedUnits: task.failedUnits,
      metadata: task.metadata ? this.mapJsonObject(task.metadata) : null,
      payload: this.mapJsonObject(task.payload),
      result: task.result ? this.mapJsonObject(task.result) : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      logs: task.logs.map((log) => ({
        id: log.id,
        taskId: log.taskId,
        level: log.level as TaskLogLevel,
        step: log.step,
        status: log.status,
        message: log.message,
        context: log.context ? this.mapJsonObject(log.context) : null,
        createdAt: log.createdAt,
      })),
      units: task.units.map((unit) => this.mapUnit(unit)),
      transactions: task.transactions.map((tx) => this.mapTransaction(tx)),
    };
  }

  private async getTaskDetailsInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<TaskDetails> {
    const task = await tx.task.findUniqueOrThrow({
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

    return this.mapTask(task);
  }

  private mapUnit(unit: TaskUnit): TaskUnitRecord {
    return {
      id: unit.id,
      taskId: unit.taskId,
      type: unit.type as TaskUnitRecord['type'],
      index: unit.index,
      status: unit.status as TaskUnitStatus,
      txHash: unit.txHash,
      error: unit.error,
      payload: this.mapJsonObject(unit.payload),
      createdAt: unit.createdAt,
      updatedAt: unit.updatedAt,
    };
  }

  private mapTransaction(tx: TaskTransaction): TaskTransactionRecord {
    return {
      id: tx.id,
      taskId: tx.taskId,
      txId: tx.txId,
      recipient: tx.recipient,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status as TxStatus,
      txHash: tx.txHash,
      errorReason: tx.errorReason,
      batchIndex: tx.batchIndex,
      pollAttempts: tx.pollAttempts,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  }

  private findNextPendingUnit(
    task: TaskDetails,
  ): Pick<TaskUnitRecord, 'id' | 'index' | 'payload' | 'status' | 'type'> | null {
    const nextUnit = task.units.find((unit) => unit.status === 'PENDING');

    if (!nextUnit) {
      return null;
    }

    return {
      id: nextUnit.id,
      index: nextUnit.index,
      payload: nextUnit.payload,
      status: nextUnit.status,
      type: nextUnit.type,
    };
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
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as TaskPayload;
    }

    return { value };
  }
}