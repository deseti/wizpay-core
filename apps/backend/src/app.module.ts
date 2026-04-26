import { Module } from '@nestjs/common';
import { AdaptersModule } from './adapters/adapters.module';
import { AgentsModule } from './agents/agents.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { QueueModule } from './queue/queue.module';
import { TaskModule } from './task/task.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AdaptersModule,
    AgentsModule,
    IntegrationsModule,
    TaskModule,
    QueueModule,
    OrchestratorModule,
  ],
})
export class AppModule {}
