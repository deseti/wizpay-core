import { BadRequestException, Injectable } from '@nestjs/common';
import { TaskType } from '../task/task-type.enum';
import { TaskDetails } from '../task/task.types';
import { AgentExecutionResult } from './agent.interface';
import { BridgeAgent } from './bridge.agent';
import { FxAgent } from './fx.agent';
import { LiquidityAgent } from './liquidity.agent';
import { PayrollAgent } from './payroll/payroll.agent';
import { SwapAgent } from './swap.agent';

@Injectable()
export class AgentRouterService {
  constructor(
    private readonly payrollAgent: PayrollAgent,
    private readonly swapAgent: SwapAgent,
    private readonly bridgeAgent: BridgeAgent,
    private readonly liquidityAgent: LiquidityAgent,
    private readonly fxAgent: FxAgent,
  ) {}

  async execute(
    taskType: TaskType,
    task: TaskDetails,
  ): Promise<AgentExecutionResult> {
    switch (taskType) {
      case TaskType.PAYROLL:
        return this.payrollAgent.execute(task);
      case TaskType.SWAP:
        return this.swapAgent.execute(task);
      case TaskType.BRIDGE:
        return this.bridgeAgent.execute(task);
      case TaskType.LIQUIDITY:
        return this.liquidityAgent.execute(task);
      case TaskType.FX:
        return this.fxAgent.execute(task);
      default:
        throw new BadRequestException(`Unsupported task type ${taskType}`);
    }
  }
}