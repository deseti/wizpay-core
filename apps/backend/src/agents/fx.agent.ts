import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TaskDetails } from '../task/task.types';
import { TaskService } from '../task/task.service';
import { AgentExecutionResult, TaskAgent } from './agent.interface';

@Injectable()
export class FxAgent implements TaskAgent {
  private readonly logger = new Logger(FxAgent.name);

  constructor(private readonly taskService: TaskService) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    this.logger.warn(
      `[fx-agent] Refused FX task ${task.id}: backend FX execution is retired on Arc Mainnet.`,
    );
    await this.taskService.logStep(
      task.id,
      'fx.execution_refused',
      'failed',
      'Backend FX execution is retired on Arc Mainnet. Use the external-wallet Uniswap V4 flow.',
    );
    throw new ServiceUnavailableException({
      code: 'FX_BACKEND_EXECUTION_UNAVAILABLE',
      message:
        'Backend FX execution is retired on Arc Mainnet. Use the external-wallet Uniswap V4 flow.',
    });
  }
}
