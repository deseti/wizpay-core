import { Injectable } from '@nestjs/common';
import { TaskDetails } from '../task/task.types';

@Injectable()
export class DexService {
  async prepareSwapExecution(task: TaskDetails) {
    return {
      adapter: 'dex',
      operation: 'swap_execution',
      taskId: task.id,
      payload: task.payload,
      mode: 'placeholder',
    };
  }

  async prepareLiquidityExecution(task: TaskDetails) {
    return {
      adapter: 'dex',
      operation: 'liquidity_execution',
      taskId: task.id,
      payload: task.payload,
      mode: 'placeholder',
    };
  }
}