import { Module } from '@nestjs/common';
import { TreasuryModule } from './treasury/treasury.module';
import { AdaptersModule } from './adapters/adapters.module';
import { AgentsModule } from './agents/agents.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { FxModule } from './fx/fx.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { OfficialSwapModule } from './official-swap/official-swap.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { QueueModule } from './queue/queue.module';
import { TaskModule } from './task/task.module';
import { UserSwapModule } from './user-swap/user-swap.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AdaptersModule,
    AgentsModule,
    FxModule,
    IntegrationsModule,
    TaskModule,
    QueueModule,
    OrchestratorModule,
    OfficialSwapModule,
    TreasuryModule,
    WalletModule,
    UserSwapModule,
  ],
})
export class AppModule {}
