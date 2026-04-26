import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Task, TaskLog } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskStatus } from './task-status.enum';
import { TaskDetails, TaskLogRecord, TaskPayload } from './task.types';

type TaskWithLogs = Task & { logs: TaskLog[] };

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TaskStatus.CREATED]: [TaskStatus.ASSIGNED, TaskStatus.FAILED],
  [TaskStatus.ASSIGNED]: [TaskStatus.IN_PROGRESS, TaskStatus.FAILED],
  [TaskStatus.IN_PROGRESS]: [TaskStatus.REVIEW, TaskStatus.EXECUTED, TaskStatus.FAILED],
  [TaskStatus.REVIEW]: [TaskStatus.APPROVED, TaskStatus.FAILED],
  [TaskStatus.APPROVED]: [TaskStatus.EXECUTED, TaskStatus.FAILED],
  [TaskStatus.EXECUTED]: [],
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
      include: { logs: true },
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

  async getTaskById(taskId: string): Promise<TaskDetails> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        logs: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    return this.mapTask(task);
  }

  private ensureTransition(currentStatus: TaskStatus, nextStatus: TaskStatus) {
    if (!ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus)) {
      throw new BadRequestException(
        `Invalid task status transition from ${currentStatus} to ${nextStatus}`,
      );
    }
  }

  private mapTask(task: TaskWithLogs): TaskDetails {
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
    };
  }

  private mapJsonObject(value: Prisma.JsonValue): TaskPayload {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as TaskPayload;
    }

    return { value };
  }
}