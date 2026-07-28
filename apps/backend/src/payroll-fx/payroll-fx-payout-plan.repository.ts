import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PayrollFxPayoutPlanConflictError } from './payroll-fx-payout-plan.errors';
import {
  mapPayrollFxPayoutPlan,
  toPrismaPayrollFxPayoutPlan,
} from './payroll-fx-payout-plan.mapper';
import type {
  CreatePayrollFxPayoutPlanInput,
  PayrollFxPayoutPlan,
} from './payroll-fx-payout-plan.types';

@Injectable()
export class PayrollFxPayoutPlanRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOperationId(
    operationId: string,
  ): Promise<PayrollFxPayoutPlan | null> {
    const record = await this.prisma.payrollFxPayoutPlan.findUnique({
      where: { operationId },
      include: { allocations: true },
    });
    return record ? mapPayrollFxPayoutPlan(record) : null;
  }

  async findByTaskId(taskId: string): Promise<PayrollFxPayoutPlan | null> {
    const record = await this.prisma.payrollFxPayoutPlan.findUnique({
      where: { taskId },
      include: { allocations: true },
    });
    return record ? mapPayrollFxPayoutPlan(record) : null;
  }

  async createOrGetImmutable(
    input: CreatePayrollFxPayoutPlanInput,
  ): Promise<PayrollFxPayoutPlan> {
    try {
      const record = await this.prisma.$transaction(
        (tx) =>
          tx.payrollFxPayoutPlan.create({
            data: toPrismaPayrollFxPayoutPlan(input),
            include: { allocations: true },
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return mapPayrollFxPayoutPlan(record);
    } catch (error) {
      if (!this.isUniqueOrSerializationConflict(error)) throw error;
      const existing =
        (await this.findByOperationId(input.operationId)) ??
        (await this.findByTaskId(input.taskId));
      if (
        existing &&
        existing.operationId === input.operationId &&
        existing.taskId === input.taskId &&
        existing.immutableInputHash === input.immutableInputHash
      ) {
        return existing;
      }
      throw new PayrollFxPayoutPlanConflictError(input.operationId);
    }
  }

  private isUniqueOrSerializationConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' ||
        error.code === 'P2014' ||
        error.code === 'P2034')
    );
  }
}
