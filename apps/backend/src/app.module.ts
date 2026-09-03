import { Module } from '@nestjs/common';
import { AppWalletSwapModule } from './app-wallet-swap/app-wallet-swap.module';
import { BridgeModule } from './bridge/bridge.module';
import { AdaptersModule } from './adapters/adapters.module';
import { AgentsModule } from './agents/agents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ActivityModule } from './activity/activity.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { FxModule } from './fx/fx.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { InvoiceModule } from './invoice/invoice.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { OfficialSwapModule } from './official-swap/official-swap.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { QueueModule } from './queue/queue.module';
import { TaskModule } from './task/task.module';
import { UserSwapModule } from './user-swap/user-swap.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  controllers: [AppController],
  providers: [AppService],
  imports: [
    AppConfigModule,
    DatabaseModule,
    AdaptersModule,
    AgentsModule,
    FxModule,
    IntegrationsModule,
    InvoiceModule,
    TaskModule,
    QueueModule,
    OrchestratorModule,
    OfficialSwapModule,
    WalletModule,
    UserSwapModule,
    AppWalletSwapModule,
    BridgeModule,
    AnalyticsModule,
    ActivityModule,
  ],
})
export class AppModule {}
