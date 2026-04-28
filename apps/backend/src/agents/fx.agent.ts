import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircleService } from '../adapters/circle.service';
import { TaskDetails } from '../task/task.types';
import { TaskService } from '../task/task.service';
import { AgentExecutionResult, TaskAgent } from './agent.interface';

@Injectable()
export class FxAgent implements TaskAgent {
  private readonly logger = new Logger(FxAgent.name);

  constructor(
    private readonly circleService: CircleService,
    private readonly configService: ConfigService,
    private readonly taskService: TaskService,
  ) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    const payload = this.normalizePayload(task.payload);

    if (!payload.quoteId || !payload.signature || !payload.senderAddress) {
      throw new Error(
        'FX payload is missing quoteId, signature, or senderAddress.',
      );
    }

    await this.taskService.logStep(
      task.id,
      'fx.trade.submitting',
      'in_progress',
      `Submitting FX trade for quote ${payload.quoteId}.`,
    );

    const createdTrade = await this.circleService.executeTrade({
      quoteId: payload.quoteId,
      signature: payload.signature,
    });

    await this.taskService.logStep(
      task.id,
      'fx.trade.submitted',
      'in_progress',
      `FX trade submitted (tradeId=${createdTrade.tradeId}).`,
      {
        context: {
          quoteId: payload.quoteId,
          tradeId: createdTrade.tradeId,
        },
      },
    );

    const finalTrade = await this.pollTradeUntilTerminal(task.id, createdTrade.tradeId);

    if (finalTrade.status !== 'settled') {
      throw new Error(
        `FX trade ${finalTrade.tradeId} ended with status ${finalTrade.status}.`,
      );
    }

    await this.taskService.logStep(
      task.id,
      'fx.trade.settled',
      'in_progress',
      `FX trade settled (tradeId=${finalTrade.tradeId}).`,
      {
        context: {
          quoteId: payload.quoteId,
          tradeId: finalTrade.tradeId,
        },
      },
    );

    return {
      agent: 'fx',
      execution: {
        adapter: 'circle',
        operation: 'stablefx_trade',
        taskId: task.id,
        payload: {
          quoteId: payload.quoteId,
          referenceId: payload.referenceId,
          senderAddress: payload.senderAddress,
        },
        trade: finalTrade,
      },
    };
  }

  private async pollTradeUntilTerminal(taskId: string, tradeId: string) {
    const maxAttempts = this.getMaxPollAttempts();
    const intervalMs = this.getPollIntervalMs();
    let previousStatus: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const trade = await this.circleService.getTradeStatus(tradeId);

      if (trade.status !== previousStatus) {
        previousStatus = trade.status;
        await this.taskService.logStep(
          taskId,
          'fx.trade.status',
          'in_progress',
          `FX trade status is ${trade.status}.`,
          {
            context: {
              attempt,
              status: trade.status,
              tradeId,
            },
          },
        );
      }

      if (trade.status === 'settled' || trade.status === 'failed') {
        return trade;
      }

      if (attempt < maxAttempts) {
        await this.waitFor(intervalMs);
      }
    }

    this.logger.error(`FX trade polling timed out for tradeId=${tradeId}`);
    throw new Error('FX trade polling timed out.');
  }

  private normalizePayload(payload: Record<string, unknown> | null): {
    quoteId: string | null;
    referenceId: string | null;
    senderAddress: string | null;
    signature: string | null;
  } {
    if (!payload || typeof payload !== 'object') {
      return {
        quoteId: null,
        referenceId: null,
        senderAddress: null,
        signature: null,
      };
    }

    return {
      quoteId: this.readString(payload, 'quoteId'),
      referenceId: this.readString(payload, 'referenceId'),
      senderAddress: this.readString(payload, 'senderAddress'),
      signature: this.readString(payload, 'signature'),
    };
  }

  private readString(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];

    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private getPollIntervalMs(): number {
    const configured = Number.parseInt(
      this.configService.get<string>('FX_POLL_INTERVAL_MS') ?? '3000',
      10,
    );

    return Number.isFinite(configured) && configured > 0 ? configured : 3000;
  }

  private getMaxPollAttempts(): number {
    const configured = Number.parseInt(
      this.configService.get<string>('FX_MAX_POLL_ATTEMPTS') ?? '60',
      10,
    );

    return Number.isFinite(configured) && configured > 0 ? configured : 60;
  }

  private waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}