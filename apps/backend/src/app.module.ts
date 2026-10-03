import { Module, type DynamicModule } from '@nestjs/common';
import {
  RuntimeModule,
  type WizPayRuntimeMode,
} from './runtime/runtime.module';
import { APP_FILTER } from '@nestjs/core';
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
import { TaskModule } from './task/task.module';
import { TaskHttpModule } from './task/task-http.module';
import { UserSwapModule } from './user-swap/user-swap.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CapabilityModule } from './capabilities/capability.module';
import { HttpExceptionCompatibilityFilter } from './common/http-exception.compatibility-filter';
import { ExecutionIntentModule } from './execution-intent/execution-intent.module';

@Module({
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: HttpExceptionCompatibilityFilter },
  ],
  imports: [
    CapabilityModule,
    ExecutionIntentModule,
    DatabaseModule,
    AdaptersModule,
    AgentsModule,
    FxModule,
    IntegrationsModule,
    InvoiceModule,
    TaskModule,
    TaskHttpModule,
    OfficialSwapModule,
    WalletModule,
    UserSwapModule,
    BridgeModule,
    AnalyticsModule,
    ActivityModule,
  ],
})
export class AppModule {
  static async forRuntime(mode: WizPayRuntimeMode): Promise<DynamicModule> {
    const imports: DynamicModule['imports'] = [
      RuntimeModule.forRoot(mode),
      AppConfigModule.forRuntime(mode),
    ];
    if (mode === 'server') {
      const [{ QueueModule }, { OrchestratorModule }] = await Promise.all([
        import('./queue/queue.module.js'),
        import('./orchestrator/orchestrator.module.js'),
      ]);
      imports.push(QueueModule, OrchestratorModule);
    }
    return { module: AppModule, imports };
  }
}
