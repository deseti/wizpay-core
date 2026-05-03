import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskLogLevel, TaskLogRecord, TaskPayload } from './task.types';

/**
 * TaskLogService — manages task audit log entries.
 *
 * Extracted from TaskService to keep log-related concerns in one place.
 * All other services should call TaskService.logStep / hasLogStep, which
 * delegate here; direct injection is also fine where TaskService is not needed.
 */
@Injectable()
export class TaskLogService {
  constructor(private readonly prisma: PrismaService) {}

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

    return this.mapLog(log);
  }

  async hasLogStep(taskId: string, step: string): Promise<boolean> {
    const existingLog = await this.prisma.taskLog.findFirst({
      where: { taskId, step },
      select: { id: true },
    });

    return existingLog != null;
  }

  mapLog(log: {
    id: string;
    taskId: string;
    level: string;
    step: string;
    status: string;
    message: string;
    context: Prisma.JsonValue;
    createdAt: Date;
  }): TaskLogRecord {
    return {
      id: log.id,
      taskId: log.taskId,
      level: log.level as TaskLogLevel,
      step: log.step,
      status: log.status,
      message: log.message,
      context: log.context ? this.mapJsonValue(log.context) : null,
      createdAt: log.createdAt,
    };
  }

  private mapJsonValue(value: Prisma.JsonValue): TaskPayload {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as TaskPayload;
    }
    return { value };
  }
}
