import { Module, forwardRef } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { AnsModule } from '../ans/ans.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { WalletModule } from '../modules/wallet/wallet.module';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { AgentRouterService } from './agent-router.service';
import { BridgeAgent } from './bridge.agent';
import { FxAgent } from './fx.agent';
import { LiquidityAgent } from './liquidity.agent';
import { PayrollAgent } from './payroll/payroll.agent';
import { PayrollBatchService } from './payroll/payroll-batch.service';
import { PayrollValidationService } from './payroll/payroll-validation.service';
import { SwapAgent } from './swap.agent';

@Module({
  imports: [AnsModule, AdaptersModule, TaskModule, QueueModule, WalletModule, forwardRef(() => OrchestratorModule)],
  providers: [
    PayrollAgent,
    PayrollBatchService,
    PayrollValidationService,
    SwapAgent,
    BridgeAgent,
    FxAgent,
    LiquidityAgent,
    AgentRouterService,
  ],
  exports: [AgentRouterService, PayrollBatchService, PayrollValidationService],
})
export class AgentsModule {}
