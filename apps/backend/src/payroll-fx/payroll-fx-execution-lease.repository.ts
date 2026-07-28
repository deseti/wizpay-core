import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import type {
  PayrollFxClock,
  PayrollFxExecutionLease,
} from './payroll-fx-execution-lease.types';
import { SYSTEM_PAYROLL_FX_CLOCK } from './payroll-fx-execution-lease.types';

@Injectable()
export class PayrollFxExecutionLeaseRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: PayrollFxClock = SYSTEM_PAYROLL_FX_CLOCK,
  ) {}

  async acquire(
    operationId: string,
    durationMs: number,
    leaseId = randomUUID(),
  ): Promise<PayrollFxExecutionLease | null> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + durationMs);
    const result = await this.prisma.payrollFxOperation.updateMany({
      where: {
        operationId,
        OR: [
          { executionLeaseId: null },
          { executionLeaseExpiresAt: null },
          { executionLeaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: expiresAt,
        executionAttemptCount: { increment: 1 },
        lastAttemptStartedAt: now,
        lastAttemptFinishedAt: null,
      },
    });
    if (result.count !== 1) return null;

    const record = await this.prisma.payrollFxOperation.findUniqueOrThrow({
      where: { operationId },
      select: { executionAttemptCount: true },
    });
    return {
      operationId,
      leaseId,
      expiresAt,
      attemptCount: record.executionAttemptCount,
    };
  }

  async renew(
    lease: PayrollFxExecutionLease,
    durationMs: number,
  ): Promise<PayrollFxExecutionLease | null> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + durationMs);
    const result = await this.prisma.payrollFxOperation.updateMany({
      where: {
        operationId: lease.operationId,
        executionLeaseId: lease.leaseId,
        executionLeaseExpiresAt: { gt: now },
      },
      data: { executionLeaseExpiresAt: expiresAt },
    });
    return result.count === 1 ? { ...lease, expiresAt } : null;
  }

  async release(lease: PayrollFxExecutionLease): Promise<boolean> {
    const now = this.clock.now();
    const result = await this.prisma.payrollFxOperation.updateMany({
      where: {
        operationId: lease.operationId,
        executionLeaseId: lease.leaseId,
        executionLeaseExpiresAt: { gt: now },
      },
      data: {
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        lastAttemptFinishedAt: now,
      },
    });
    return result.count === 1;
  }
}
