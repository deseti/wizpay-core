import { BadRequestException, Injectable } from '@nestjs/common';
import { TaskType } from './task-type.enum';
import { TaskService } from './task.service';
import type { TaskEmployeeBreakdownItem } from './task.types';

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  EURC: 6,
};

@Injectable()
export class TaskEmployeeBreakdownService {
  constructor(private readonly taskService: TaskService) {}

  async getPayrollEmployeeBreakdown(
    taskId: string,
  ): Promise<TaskEmployeeBreakdownItem[]> {
    const task = await this.taskService.getTaskById(taskId);

    if (task.type !== TaskType.PAYROLL) {
      throw new BadRequestException(
        'Employee breakdown is only available for payroll tasks.',
      );
    }

    return task.transactions
      .filter(
        (transaction) =>
          transaction.status === 'completed' &&
          typeof transaction.txHash === 'string' &&
          transaction.txHash.trim().length > 0,
      )
      .map((transaction) => {
        const tokenSymbol = this.normalizeTokenSymbol(transaction.currency);
        const tokenDecimals = this.resolveTokenDecimals(tokenSymbol);

        return {
          taskId: task.id,
          date: transaction.updatedAt.getTime(),
          employee: transaction.recipient,
          status: 'Confirmed',
          amount: this.parseAmountToUnits(
            transaction.amount,
            tokenDecimals,
          ).toString(),
          tokenSymbol,
          tokenDecimals,
          txHash: transaction.txHash as string,
        } satisfies TaskEmployeeBreakdownItem;
      })
      .sort((left, right) => right.date - left.date);
  }

  private normalizeTokenSymbol(value: string): string {
    const normalized = value.trim().toUpperCase();
    return normalized || 'USDC';
  }

  private resolveTokenDecimals(symbol: string): number {
    return TOKEN_DECIMALS[symbol] ?? 6;
  }

  private parseAmountToUnits(value: string, decimals: number): bigint {
    const normalized = value.trim();

    if (!normalized) {
      return 0n;
    }

    const [wholePart = '0', fractionalPart = ''] = normalized.split('.');

    if (
      normalized.split('.').length > 2 ||
      !/^\d+$/.test(wholePart || '0') ||
      (fractionalPart.length > 0 && !/^\d+$/.test(fractionalPart))
    ) {
      return 0n;
    }

    const whole = wholePart || '0';
    const fraction = fractionalPart.padEnd(decimals, '0').slice(0, decimals);

    return BigInt(`${whole}${fraction || ''.padEnd(decimals, '0')}`);
  }
}