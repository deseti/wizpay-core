import { Injectable } from '@nestjs/common';
import { Prisma, Task, TaskLog, TaskTransaction, TaskUnit } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskTransactionService } from './task-transaction.service';
import {
  TaskDetails,
  TaskLogLevel,
  TaskPayload,
  TaskTransactionRecord,
  TaskUnitRecord,
  TaskUnitStatus,
} from './task.types';

export type TaskWithRelations = Task & {
  logs: TaskLog[];
  units: TaskUnit[];
  transactions: TaskTransaction[];
};

/**
 * TaskMapperService — converts raw Prisma models to typed domain records.
 *
 * Extracted from TaskService so that TaskUnitService can reuse the same
 * mappers without introducing a circular dependency.
 */
@Injectable()
export class TaskMapperService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskTransactionService: TaskTransactionService,
  ) {}

  // ─── Mappers ────────────────────────────────────────────────────────

  mapTask(task: TaskWithRelations): TaskDetails {
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
      transactions: task.transactions.map((tx) =>
        this.taskTransactionService.mapTransaction(tx as TaskTransaction),
      ),
    };
  }

  mapUnit(unit: TaskUnit): TaskUnitRecord {
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

  mapJsonObject(value: Prisma.JsonValue): TaskPayload {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as TaskPayload;
    }
    return { value };
  }

  // ─── Transactional query helper ──────────────────────────────────────

  /**
   * Fetch and map a task with all relations inside an active Prisma transaction.
   * Used by TaskUnitService.reportUnit() and TaskService internally.
   */
  async getTaskDetailsInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<TaskDetails> {
    const task = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        logs: { orderBy: { createdAt: 'asc' } },
        units: { orderBy: [{ index: 'asc' }, { createdAt: 'asc' }] },
        transactions: {
          orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    return this.mapTask(task);
  }
}
