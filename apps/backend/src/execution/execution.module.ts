import { Module, forwardRef } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { AgentsModule } from '../agents/agents.module';
import { TaskModule } from '../task/task.module';
import { ExecutionRouterService } from './execution-router.service';

/**
 * ExecutionModule — owns the Mainnet execution layer.
 *
 * Provides:
 *  - ExecutionRouterService  (central dispatch: external-wallet only)
 *
 * Exports:
 *  - ExecutionRouterService  (consumed by OrchestratorModule)
 *
 * Dependency graph (→ = imports):
 *   OrchestratorModule → ExecutionModule → AgentsModule
 *                                         AdaptersModule
 *                                         TaskModule
 *   AgentsModule → forwardRef(OrchestratorModule)   ← cycle broken by forwardRef
 */
@Module({
  imports: [
    AdaptersModule,
    TaskModule,
    /**
     * AgentsModule provides AgentRouterService which ExecutionRouterService
     * uses for the external-wallet path.
     *
     * forwardRef is required because AgentsModule → OrchestratorModule →
     * ExecutionModule → AgentsModule forms a cycle.
     */
    forwardRef(() => AgentsModule),
  ],
  providers: [ExecutionRouterService],
  exports: [ExecutionRouterService],
})
export class ExecutionModule {}
