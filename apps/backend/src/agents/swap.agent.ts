import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TaskDetails } from '../task/task.types';
import { AgentExecutionResult, TaskAgent } from './agent.interface';

@Injectable()
export class SwapAgent implements TaskAgent {
  private readonly logger = new Logger(SwapAgent.name);

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    this.logger.warn(
      `[swap-agent] Refused swap task ${task.id}: backend swap submission is retired on Arc Mainnet.`,
    );
    throw new ServiceUnavailableException({
      code: 'SWAP_BACKEND_EXECUTION_UNAVAILABLE',
      message:
        'Backend swap submission is retired on Arc Mainnet. Swaps are prepared through the Mainnet Uniswap V4 endpoints and signed by the external wallet.',
    });
  }
}
