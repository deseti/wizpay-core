import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { TaskModule } from '../task/task.module';
import { AgentRouterService } from './agent-router.service';
import { BridgeAgent } from './bridge.agent';
import { LiquidityAgent } from './liquidity.agent';
import { PayrollAgent } from './payroll/payroll.agent';
import { SwapAgent } from './swap.agent';

@Module({
  imports: [AdaptersModule, TaskModule],
  providers: [
    PayrollAgent,
    SwapAgent,
    BridgeAgent,
    LiquidityAgent,
    AgentRouterService,
  ],
  exports: [AgentRouterService, PayrollAgent],
})
export class AgentsModule {}