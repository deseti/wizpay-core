import { Module, forwardRef } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { AgentsModule } from '../agents/agents.module';
import { ExecutionModule } from '../execution/execution.module';
import { FxModule } from '../fx/fx.module';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { UserSwapModule } from '../user-swap/user-swap.module';
import { PayrollFxSettlementService } from '../agents/payroll/payroll-fx-settlement.service';
import { AppWalletSwapDepositVerifierService } from '../app-wallet-swap/app-wallet-swap-deposit-verifier.service';
import { OrchestratorService } from './orchestrator.service';
import { PayrollInitService } from './payroll-init.service';
import { TaskController } from './task.controller';

@Module({
  imports: [
    TaskModule,
    AdaptersModule,
    FxModule,
    UserSwapModule,
    forwardRef(() => QueueModule),
    forwardRef(() => AgentsModule),
    ExecutionModule,
  ],
  controllers: [TaskController],
  providers: [
    OrchestratorService,
    PayrollInitService,
    PayrollFxSettlementService,
    AppWalletSwapDepositVerifierService,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
