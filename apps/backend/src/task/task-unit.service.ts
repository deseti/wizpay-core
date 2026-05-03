import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { normalizeChainTxId } from '../common/multichain';
import {
  ReportTaskUnitInput,
  ReportTaskUnitResult,
  TaskDetails,
  TaskUnitRecord,
} from './task.types';
import { TaskStatus } from './task-status.enum';
import { TaskMapperService } from './task-mapper.service';

/**
 * TaskUnitService — manages the lifecycle of individual task units.
 *
 * Extracted from TaskService to isolate unit-reporting and status-
 * recomputation logic. TaskService delegates reportUnit() and
 * recomputeTaskStatus() here; callers that only need these two
 * methods can inject this service directly.
 */
@Injectable()
export class TaskUnitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskMapper: TaskMapperService,
  ) {}

  /**
   * Report the result of a single task unit (SUCCESS or FAILED).
   * Runs inside a Prisma transaction to keep counter increments and
   * status transitions atomic.
   */
  async reportUnit(
    taskId: string,
    unitId: string,
    result: ReportTaskUnitInput,
  ): Promise<ReportTaskUnitResult> {
    return this.prisma.$transaction(async (tx) => {
      const normalizedTxHash =
        result.txHash === undefined
          ? undefined
          : normalizeChainTxId(result.txHash);

      const unit = await tx.taskUnit.findFirst({
        where: { id: unitId, taskId },
      });

      if (!unit) {
        throw new NotFoundException(
          `Task unit ${unitId} for task ${taskId} not found`,
        );
      }

      // Idempotent — if already reported, return current state
      if (unit.status !== 'PENDING') {
        const task = await this.taskMapper.getTaskDetailsInTransaction(
          tx,
          taskId,
        );
        return {
          task,
          unit: this.taskMapper.mapUnit(unit),
          nextUnit: this.findNextPendingUnit(task),
        };
      }

      const updatedUnit = await tx.taskUnit.update({
        where: { id: unit.id },
        data: {
          status: result.status,
          ...(normalizedTxHash !== undefined
            ? { txHash: normalizedTxHash }
            : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      });

      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
      });

      await tx.task.update({
        where: { id: taskId },
        data: {
          completedUnits:
            result.status === 'SUCCESS' ? { increment: 1 } : undefined,
          failedUnits:
            result.status === 'FAILED' ? { increment: 1 } : undefined,
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
            txHash: normalizedTxHash ?? null,
            unitId: updatedUnit.id,
            unitIndex: updatedUnit.index,
            unitStatus: result.status,
          } as Prisma.InputJsonValue,
        },
      });

      const fullTask = await this.taskMapper.getTaskDetailsInTransaction(
        tx,
        taskId,
      );

      return {
        task: fullTask,
        unit: this.taskMapper.mapUnit(updatedUnit),
        nextUnit: this.findNextPendingUnit(fullTask),
      };
    });
  }

  /**
   * Derive the next task status from unit counters.
   * Pure function — no I/O.
   */
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

  // ─── Private helpers ────────────────────────────────────────────────

  private findNextPendingUnit(
    task: TaskDetails,
  ): Pick<
    TaskUnitRecord,
    'id' | 'index' | 'payload' | 'status' | 'type'
  > | null {
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
}
