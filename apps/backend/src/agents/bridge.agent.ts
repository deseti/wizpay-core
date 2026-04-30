import { Injectable, Logger } from '@nestjs/common';
import { CircleBridgeService } from '../adapters/circle/circle-bridge.service';
import { normalizeChainTxId } from '../common/multichain';
import { TaskService } from '../task/task.service';
import { AgentExecutionResult, TaskAgent } from './agent.interface';
import { TaskDetails } from '../task/task.types';

@Injectable()
export class BridgeAgent implements TaskAgent {
  private readonly logger = new Logger(BridgeAgent.name);

  constructor(
    private readonly circleBridgeService: CircleBridgeService,
    private readonly taskService: TaskService,
  ) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    const payload = this.normalizePayload(task);

    await this.taskService.logStep(
      task.id,
      'bridge.submitting',
      'in_progress',
      `Submitting bridge ${payload.amount} ${payload.token} from ${payload.sourceBlockchain} to ${payload.destinationBlockchain}.`,
      {
        context: {
          destinationAddress: payload.destinationAddress,
          referenceId: payload.referenceId,
          sourceWalletAddress: payload.walletAddress,
          walletId: payload.walletId,
        },
      },
    );

    const transfer = await this.circleBridgeService.initiateBridge({
      amount: payload.amount,
      destinationAddress: payload.destinationAddress,
      destinationBlockchain: payload.destinationBlockchain,
      referenceId: payload.referenceId,
      sourceBlockchain: payload.sourceBlockchain,
      sourceWalletAddress: payload.walletAddress,
      taskId: task.id,
      token: payload.token,
      walletId: payload.walletId,
    });

    const failedStep = transfer.steps.find((step) => step.state === 'error');

    if (transfer.status === 'failed') {
      throw new Error(
        failedStep?.errorMessage ||
          `Bridge ${transfer.transferId} failed during Circle execution.`,
      );
    }

    await this.taskService.logStep(
      task.id,
      'bridge.completed',
      'in_progress',
      `Bridge ${transfer.transferId} completed.`,
      {
        context: {
          provider: transfer.provider,
          transferId: transfer.transferId,
          txHashBurn: transfer.txHashBurn,
          txHashMint: transfer.txHashMint,
        },
      },
    );

    return {
      agent: 'bridge',
      execution: {
        adapter: 'circle-bridge-kit',
        operation: 'cctp_bridge',
        payload,
        transfer,
        normalizedTransfer: {
          destinationChain: payload.destinationChain,
          sourceChain: payload.sourceChain,
          status: transfer.status,
          steps: transfer.steps.map((step) => ({
            chain: null,
            explorerUrl: step.explorerUrl,
            id: step.id,
            name: step.name,
            state: step.state,
            txId: normalizeChainTxId(step.txHash),
          })),
          transferId: transfer.transferId,
          txId: normalizeChainTxId(transfer.txHash),
          txIdBurn: normalizeChainTxId(transfer.txHashBurn),
          txIdMint: normalizeChainTxId(transfer.txHashMint),
        },
        taskId: task.id,
      },
    };
  }

  private normalizePayload(task: TaskDetails) {
    const payload = task.payload ?? {};

    return {
      amount: this.readRequiredString(payload, 'amount'),
      destinationAddress: this.readRequiredString(payload, 'destinationAddress'),
      destinationBlockchain:
        this.readString(payload, 'destinationBlockchain') ??
        this.readRequiredString(payload, 'blockchain'),
      destinationChain: this.readString(payload, 'destinationChain'),
      referenceId:
        this.readString(payload, 'referenceId') ?? `BRIDGE-${task.id}`,
      sourceBlockchain:
        this.readString(payload, 'sourceBlockchain') ??
        this.readRequiredString(payload, 'sourceChain'),
      sourceChain: this.readString(payload, 'sourceChain'),
      token: this.readString(payload, 'token') ?? 'USDC',
      walletAddress: this.readRequiredString(payload, 'walletAddress'),
      walletId: this.readRequiredString(payload, 'walletId'),
    };
  }

  private readRequiredString(
    source: Record<string, unknown>,
    key: string,
  ): string {
    const value = this.readString(source, key);

    if (!value) {
      this.logger.error(`Bridge payload missing ${key}.`);
      throw new Error(`Bridge payload missing required field: ${key}`);
    }

    return value;
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
}
