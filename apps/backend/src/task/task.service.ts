import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Task, TaskLog, TaskTransaction } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskStatus } from './task-status.enum';
import {
  AppendTransactionInput,
  TaskDetails,
  TaskLogRecord,
  TaskPayload,
  TaskTransactionRecord,
  TxStatus,
  UpdateTransactionInput,
} from './task.types';

type TaskWithRelations = Task & { logs: TaskLog[]; transactions: TaskTransaction[] };

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
  constructor(private readonly prisma: PrismaService) {}

  async createTask(type: string, payload: TaskPayload): Promise<TaskDetails> {
    const task = await this.prisma.task.create({
      data: {
        type,
        status: TaskStatus.CREATED,
        payload: payload as Prisma.InputJsonValue,
      },
      include: { logs: true, transactions: true },
    });

    await this.logStep(
      task.id,
      'task.created',
      TaskStatus.CREATED,
      `Task ${type} created`,
    );

    return this.getTaskById(task.id);
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
  ): Promise<TaskLogRecord> {
    const log = await this.prisma.taskLog.create({
      data: {
        taskId,
        step,
        status,
        message,
      },
    });

    return {
      id: log.id,
      taskId: log.taskId,
      step: log.step,
      status: log.status,
      message: log.message,
      createdAt: log.createdAt,
    };
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
      payload: this.mapJsonObject(task.payload),
      result: task.result ? this.mapJsonObject(task.result) : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      logs: task.logs.map((log) => ({
        id: log.id,
        taskId: log.taskId,
        step: log.step,
        status: log.status,
        message: log.message,
        createdAt: log.createdAt,
      })),
      transactions: task.transactions.map((tx) => this.mapTransaction(tx)),
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

  private mapJsonObject(value: Prisma.JsonValue): TaskPayload {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as TaskPayload;
    }

    return { value };
  }
}