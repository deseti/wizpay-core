import { Injectable } from '@nestjs/common';
import type { Task, TaskUnit } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { buildPayrollFxOperationIdempotencyKey } from './payroll-fx-idempotency';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import type { PayrollFxOperation } from './payroll-fx-operation.types';
import { PayrollFxTaskBindingConflictError } from './payroll-fx-payout-plan.errors';

export type PayrollFxTaskWithUnits = Task & { units: TaskUnit[] };

@Injectable()
export class PayrollFxTaskBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: PayrollFxOperationRepository,
  ) {}

  async bindEligibleTask(taskId: string): Promise<{
    operation: PayrollFxOperation;
    task: PayrollFxTaskWithUnits;
  } | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { units: { orderBy: { index: 'asc' } } },
    });
    if (!task || task.type !== 'payroll') return null;

    const operation = await this.findCorrelatedOperation(task);
    if (!operation) return null;
    this.assertCompatible(task, operation);
    const attached = await this.operations.attachTask(
      operation.operationId,
      task.id,
    );
    return { operation: attached, task };
  }

  private async findCorrelatedOperation(
    task: PayrollFxTaskWithUnits,
  ): Promise<PayrollFxOperation | null> {
    const metadata = this.asObject(task.metadata);
    const referenceId = this.requiredString(
      metadata.referenceId,
      'referenceId',
    );
    const sourceToken = this.requiredString(
      metadata.sourceToken,
      'sourceToken',
    );
    const destinationTokens = this.readDestinationTokens(task).filter(
      (token) => token !== sourceToken.toUpperCase(),
    );
    if (destinationTokens.length === 0) return null;
    if (destinationTokens.length !== 1) {
      throw new PayrollFxTaskBindingConflictError(
        'A Payroll FX task must resolve to exactly one cross-currency destination token.',
      );
    }

    const destinationToken = destinationTokens[0];
    const references = [
      referenceId,
      `PAYROLL-FX-${referenceId}-${destinationToken}`,
    ];
    const matches = (
      await Promise.all(
        references.map((candidate) =>
          this.operations.findByIdempotencyKey(
            buildPayrollFxOperationIdempotencyKey(candidate),
          ),
        ),
      )
    ).filter((value): value is PayrollFxOperation => value !== null);
    const unique = new Map(
      matches.map((operation) => [operation.operationId, operation]),
    );
    if (unique.size > 1) {
      throw new PayrollFxTaskBindingConflictError(
        'Payroll task correlation matched more than one FX operation.',
      );
    }
    return [...unique.values()][0] ?? null;
  }

  private assertCompatible(
    task: PayrollFxTaskWithUnits,
    operation: PayrollFxOperation,
  ): void {
    const metadata = this.asObject(task.metadata);
    const payload = this.asObject(task.payload);
    const sourceToken = this.requiredString(
      metadata.sourceToken,
      'sourceToken',
    );
    const walletAddress = this.requiredString(
      metadata.walletAddress,
      'walletAddress',
    ).toLowerCase();
    const network =
      typeof payload.network === 'string' && payload.network.trim()
        ? payload.network.trim()
        : 'ARC-TESTNET';
    const destinationTokens = this.readDestinationTokens(task);

    const conflicts = [
      operation.executionProvider !== 'stablefx'
        ? 'persisted provider is not StableFX'
        : null,
      operation.walletMode !== 'app' ? 'wallet mode is not App Wallet' : null,
      operation.sourceWalletAddress.toLowerCase() !== walletAddress
        ? 'App Wallet ownership differs'
        : null,
      operation.network.toUpperCase() !== network.toUpperCase()
        ? 'network differs'
        : null,
      operation.sourceTokenSymbol.toUpperCase() !== sourceToken.toUpperCase()
        ? 'source token differs'
        : null,
      !destinationTokens.includes(
        operation.destinationTokenSymbol.toUpperCase(),
      )
        ? 'destination token differs'
        : null,
      operation.taskId !== null && operation.taskId !== task.id
        ? 'operation is already attached to another task'
        : null,
    ].filter((value): value is string => value !== null);

    if (conflicts.length > 0) {
      throw new PayrollFxTaskBindingConflictError(
        `Payroll task and FX operation are incompatible: ${conflicts.join(', ')}.`,
      );
    }
  }

  private readDestinationTokens(task: PayrollFxTaskWithUnits): string[] {
    const tokens = new Set<string>();
    for (const unit of task.units) {
      const payload = this.asObject(unit.payload);
      if (!Array.isArray(payload.recipients)) continue;
      for (const rawRecipient of payload.recipients) {
        const recipient = this.asObject(rawRecipient);
        const token = this.requiredString(
          recipient.targetToken,
          'recipient targetToken',
        );
        tokens.add(token.toUpperCase());
      }
    }
    return [...tokens].sort();
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new PayrollFxTaskBindingConflictError(
        `Payroll task is missing immutable ${label}.`,
      );
    }
    return value.trim();
  }
}
