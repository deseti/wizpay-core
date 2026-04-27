import { Injectable } from '@nestjs/common';
import { BlockchainService } from '../adapters/blockchain.service';
import { TaskDetails } from '../task/task.types';
import { AgentExecutionResult, TaskAgent } from './agent.interface';

@Injectable()
export class BridgeAgent implements TaskAgent {
  constructor(private readonly blockchainService: BlockchainService) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    // TODO: Implement real bridge execution via BlockchainService.
    // The previous prepareBridgeTransfer() was a placeholder.
    // When implemented, this will:
    //   1. Validate bridge parameters (source chain, dest chain, amount)
    //   2. Call the bridge contract via blockchainService.sendTransaction()
    //   3. Monitor cross-chain confirmation

    return {
      agent: 'bridge',
      execution: {
        adapter: 'blockchain',
        operation: 'bridge_contract_call',
        taskId: task.id,
        payload: task.payload,
        mode: 'placeholder',
      },
    };
  }
}