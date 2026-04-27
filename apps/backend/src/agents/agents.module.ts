import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { AgentRouterService } from './agent-router.service';
import { BridgeAgent } from './bridge.agent';
import { LiquidityAgent } from './liquidity.agent';
import { PayrollAgent } from './payroll/payroll.agent';
import { PayrollBatchService } from './payroll/payroll-batch.service';
import { PayrollValidationService } from './payroll/payroll-validation.service';
import { SwapAgent } from './swap.agent';

@Module({
  imports: [AdaptersModule, TaskModule, QueueModule],
  providers: [
    PayrollAgent,
    PayrollBatchService,
    PayrollValidationService,
    SwapAgent,
    BridgeAgent,
    LiquidityAgent,
    AgentRouterService,
  ],
  exports: [AgentRouterService, PayrollBatchService, PayrollValidationService],
})
export class AgentsModule {}
