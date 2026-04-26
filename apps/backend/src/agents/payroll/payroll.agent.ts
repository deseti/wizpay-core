import { Injectable, Logger } from '@nestjs/common';
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

/**
 * PayrollAgent executes payroll transfers.
 *
 * Status management contract:
 * - This agent does NOT call updateStatus() for in_progress / executed / failed.
 *   Those transitions are owned by OrchestratorService.executeTask().
 * - The agent only writes intermediate log steps for individual transfers.
 *
 * Called by: OrchestratorService → AgentRouterService → PayrollAgent
 * Worker MUST NOT call this class directly.
 */
@Injectable()
export class PayrollAgent implements TaskAgent {
  private readonly logger = new Logger(PayrollAgent.name);

  constructor(
    private readonly circleService: CircleService,
    private readonly taskService: TaskService,
  ) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    this.logger.log(`Payroll agent executing — taskId=${task.id}`);

    const recipients = this.getRecipients(task.payload);
    const transfers: Array<TaskPayload> = [];

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

      this.logger.log(
        `Transfer completed — taskId=${task.id} to=${recipient.to} amount=${recipient.amount} ${recipient.currency} txId=${transferResult.txId}`,
      );
    }

    const result = {
      agent: 'payroll',
      transfers,
    } satisfies TaskPayload;

    this.logger.log(`Payroll agent done — taskId=${task.id} transfers=${transfers.length}`);

    return result;
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