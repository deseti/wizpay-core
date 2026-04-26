import { Injectable } from '@nestjs/common';
import { CircleService } from '../../adapters/circle.service';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import { TaskDetails, TaskPayload } from '../../task/task.types';
import { AgentExecutionResult, TaskAgent } from '../agent.interface';

interface PayrollRecipient {
  to: string;
  amount: number;
  currency: string;
}

@Injectable()
export class PayrollAgent implements TaskAgent {
  constructor(
    private readonly circleService: CircleService,
    private readonly taskService: TaskService,
  ) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    await this.taskService.updateStatus(task.id, TaskStatus.IN_PROGRESS, {
      step: 'task.in_progress',
      message: 'Payroll execution started',
    });

    const recipients = this.getRecipients(task.payload);
    const transfers: Array<TaskPayload> = [];

    try {
      for (const recipient of recipients) {
        const transferResult = await this.circleService.transfer(recipient);

        transfers.push({
          to: recipient.to,
          amount: recipient.amount,
          currency: recipient.currency,
          txId: transferResult.txId,
        });

        await this.taskService.logStep(
          task.id,
          'payroll.transfer',
          TaskStatus.IN_PROGRESS,
          `Transferred ${recipient.amount} ${recipient.currency} to ${recipient.to}`,
        );
      }

      const result = {
        agent: 'payroll',
        transfers,
      } satisfies TaskPayload;

      await this.taskService.updateStatus(task.id, TaskStatus.EXECUTED, {
        step: 'task.executed',
        message: 'Payroll execution completed',
        result,
      });

      return result;
    } catch (error) {
      await this.taskService.updateStatus(task.id, TaskStatus.FAILED, {
        step: 'task.failed',
        message:
          error instanceof Error ? error.message : 'Payroll execution failed',
      });

      throw error;
    }
  }

  private getRecipients(payload: TaskPayload): PayrollRecipient[] {
    const recipients = payload.recipients;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error('Payroll task payload must include recipients');
    }

    return recipients.map((recipient) => {
      if (
        !recipient ||
        typeof recipient !== 'object' ||
        Array.isArray(recipient) ||
        typeof recipient.to !== 'string' ||
        typeof recipient.amount !== 'number' ||
        typeof recipient.currency !== 'string'
      ) {
        throw new Error('Payroll task payload contains an invalid recipient');
      }

      return {
        to: recipient.to,
        amount: recipient.amount,
        currency: recipient.currency,
      };
    });
  }
}