import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskDetails } from '../task/task.types';
import { TaskService } from '../task/task.service';
import { AgentExecutionResult, TaskAgent } from './agent.interface';

@Injectable()
export class BridgeAgent implements TaskAgent {
  private readonly logger = new Logger(BridgeAgent.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly taskService: TaskService,
  ) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    const bridgePayload = this.normalizeBridgePayload(task.payload);

    if (!bridgePayload.destinationAddress || !bridgePayload.amount) {
      throw new Error(
        'Bridge payload is missing destinationAddress or amount.',
      );
    }

    await this.taskService.logStep(
      task.id,
      'bridge.submitting',
      task.status,
      'Submitting bridge transfer via Circle API gateway.',
    );

    const createdTransfer = await this.createTransfer(bridgePayload);
    const transferId = this.readString(createdTransfer, 'transferId');

    if (!transferId) {
      throw new Error('Bridge API did not return transferId.');
    }

    await this.taskService.logStep(
      task.id,
      'bridge.submitted',
      task.status,
      `Bridge transfer submitted (transferId=${transferId}).`,
      {
        context: {
          transferId,
        },
      },
    );

    const finalTransfer = await this.pollUntilTerminal(task.id, transferId);
    const rawStatus = this.readString(finalTransfer, 'status') ?? 'unknown';

    if (rawStatus !== 'settled') {
      const reason = this.readString(finalTransfer, 'errorReason');
      throw new Error(
        reason || `Bridge transfer ended with non-settled status: ${rawStatus}`,
      );
    }

    await this.taskService.logStep(
      task.id,
      'bridge.completed',
      task.status,
      `Bridge transfer settled (transferId=${transferId}).`,
      {
        context: {
          transferId,
          status: rawStatus,
        },
      },
    );

    return {
      agent: 'bridge',
      execution: {
        adapter: 'circle',
        operation: 'bridge_transfer',
        taskId: task.id,
        payload: bridgePayload,
        transfer: finalTransfer,
      },
    };
  }

  private async pollUntilTerminal(
    taskId: string,
    transferId: string,
  ): Promise<Record<string, unknown>> {
    const maxAttempts = this.getMaxPollAttempts();
    const pollDelayMs = this.getPollDelayMs();
    let previousStage: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const transfer = await this.getTransferStatus(transferId);
      const status = this.readString(transfer, 'status') ?? 'unknown';
      const stage = this.readString(transfer, 'stage');

      if (stage && stage !== previousStage) {
        previousStage = stage;
        await this.taskService.logStep(
          taskId,
          'bridge.stage_changed',
          'in_progress',
          `Bridge stage changed to ${stage}.`,
          {
            context: {
              attempt,
              stage,
              status,
              transferId,
            },
          },
        );
      }

      if (status === 'settled' || status === 'failed') {
        return transfer;
      }

      if (attempt < maxAttempts) {
        await this.waitFor(pollDelayMs);
      }
    }

    this.logger.error(
      `Bridge transfer polling timed out (transferId=${transferId}).`,
    );
    throw new Error('Bridge transfer polling timed out.');
  }

  private async createTransfer(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.fetchTransferApi('/api/transfers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  private async getTransferStatus(
    transferId: string,
  ): Promise<Record<string, unknown>> {
    return this.fetchTransferApi(`/api/transfers/${encodeURIComponent(transferId)}`);
  }

  private async fetchTransferApi(
    path: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.getFrontendApiUrl(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json().catch(() => ({}))) as
      | Record<string, unknown>
      | null;

    if (!response.ok) {
      const message = this.readString(payload ?? {}, 'error');
      throw new Error(message || `Bridge API request failed (${response.status}).`);
    }

    const data = payload && 'data' in payload ? payload.data : payload;

    if (!data || typeof data !== 'object') {
      throw new Error('Bridge API returned an empty payload.');
    }

    return data as Record<string, unknown>;
  }

  private normalizeBridgePayload(
    payload: Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    return {
      destinationAddress: this.readString(payload, 'destinationAddress'),
      amount: this.readString(payload, 'amount'),
      referenceId: this.readString(payload, 'referenceId'),
      tokenAddress: this.readString(payload, 'tokenAddress'),
      walletId: this.readString(payload, 'walletId'),
      walletAddress: this.readString(payload, 'walletAddress'),
      blockchain: this.readString(payload, 'blockchain'),
    };
  }

  private readString(
    source: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = source[key];

    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private getFrontendApiUrl(path: string): string {
    const baseUrl =
      this.configService.get<string>('FRONTEND_API_BASE_URL') ||
      this.configService.get<string>('FRONTEND_APP_URL') ||
      'http://frontend:3000';

    return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  }

  private getPollDelayMs(): number {
    const configured = Number.parseInt(
      this.configService.get<string>('BRIDGE_POLL_INTERVAL_MS') ?? '4000',
      10,
    );

    return Number.isFinite(configured) && configured > 0 ? configured : 4000;
  }

  private getMaxPollAttempts(): number {
    const configured = Number.parseInt(
      this.configService.get<string>('BRIDGE_MAX_POLL_ATTEMPTS') ?? '90',
      10,
    );

    return Number.isFinite(configured) && configured > 0 ? configured : 90;
  }

  private waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}