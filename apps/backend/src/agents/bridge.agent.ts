import { Injectable } from '@nestjs/common';
import { BlockchainService } from '../adapters/blockchain.service';
import { TaskDetails } from '../task/task.types';
import { AgentExecutionResult, TaskAgent } from './agent.interface';

@Injectable()
export class BridgeAgent implements TaskAgent {
  constructor(private readonly blockchainService: BlockchainService) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    const execution = await this.blockchainService.prepareBridgeTransfer(task);

    return {
      agent: 'bridge',
      execution,
    };
  }
}