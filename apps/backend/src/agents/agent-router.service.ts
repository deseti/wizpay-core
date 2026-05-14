import { BadRequestException, Injectable } from '@nestjs/common';
import { TaskType } from '../task/task-type.enum';
import { TaskDetails } from '../task/task.types';
import { AgentExecutionResult } from './agent.interface';
import { BridgeAgent } from './bridge.agent';
import { FxAgent } from './fx.agent';
import { LiquidityAgent } from './liquidity.agent';
import { PayrollAgent } from './payroll/payroll.agent';
import { SwapAgent } from './swap.agent';
import {
  assertLegacyFxEnabled,
  assertLegacyLiquidityEnabled,
  throwOfficialStableFxAuthRequired,
} from '../fx/stablefx-cutover.guard';

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
        if (this.hasCrossCurrencyPayroll(task)) {
          throwOfficialStableFxAuthRequired();
        }
        return this.payrollAgent.execute(task);
      case TaskType.SWAP:
        assertLegacyFxEnabled();
        return this.swapAgent.execute(task);
      case TaskType.BRIDGE:
        return this.bridgeAgent.execute(task);
      case TaskType.LIQUIDITY:
        assertLegacyLiquidityEnabled();
        return this.liquidityAgent.execute(task);
      case TaskType.FX:
        return this.fxAgent.execute(task);
      default:
        throw new BadRequestException(`Unsupported task type ${taskType}`);
    }
  }

  private hasCrossCurrencyPayroll(task: TaskDetails): boolean {
    const payload = task.payload ?? {};
    const sourceToken =
      typeof payload.sourceToken === 'string' && payload.sourceToken.trim()
        ? payload.sourceToken.trim()
        : 'USDC';
    const recipients = Array.isArray(payload.recipients)
      ? payload.recipients
      : [];

    return recipients.some((recipient) => {
      if (!recipient || typeof recipient !== 'object') {
        return false;
      }

      const targetToken = (recipient as Record<string, unknown>).targetToken;
      return typeof targetToken === 'string' && targetToken !== sourceToken;
    });
  }
}
