import { Injectable } from '@nestjs/common';
import { DexService } from '../adapters/dex.service';
import { TaskDetails } from '../task/task.types';
import { AgentExecutionResult, TaskAgent } from './agent.interface';

@Injectable()
export class SwapAgent implements TaskAgent {
  constructor(private readonly dexService: DexService) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    const execution = await this.dexService.prepareSwapExecution(task);

    return {
      agent: 'swap',
      execution,
    };
  }
}