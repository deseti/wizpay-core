import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AgentRouterService } from '../agents/agent-router.service';
import { AgentExecutionResult } from '../agents/agent.interface';
import { TaskType } from '../task/task-type.enum';
import { TaskDetails } from '../task/task.types';
import { CapabilityService } from '../capabilities/capability.service';

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * ExecutionRouterService — central dispatch for ALL task execution.
 *
 * This is the single entry point called by OrchestratorService.
 * No agent, worker, or controller should call execution engines directly.
 *
 * Arc Mainnet is external-wallet-only: the backend never submits user
 * funds. Execution payloads are prepared for the connected wallet and
 * settlement is verified from Mainnet receipts.
 *
 * Routing logic
 * ─────────────
 *  task.payload.walletMode === "EXTERNAL_WALLET"  |  absent (default)
 *    → AgentRouterService (Mainnet preparation + fail-closed guards)
 *
 * Any other walletMode value fails closed: unknown execution paths are
 * rejected before any side effect.
 */
@Injectable()
export class ExecutionRouterService {
  private readonly logger = new Logger(ExecutionRouterService.name);

  constructor(
    private readonly agentRouter: AgentRouterService,
    private readonly capabilities: CapabilityService,
  ) {}

  /**
   * Route a task to the Mainnet execution path.
   *
   * @param task - Full task record including payload and logs.
   * @returns AgentExecutionResult — structure is engine-specific but
   *          always matches the shape expected by OrchestratorService.
   */
  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    if (String(task.type) === 'bridge') {
      throw new BadRequestException(
        'Legacy bridge task execution was removed. Use the external-wallet /bridge/intents lifecycle.',
      );
    }

    if (String(task.type) === 'liquidity') {
      this.capabilities.assert('liquidity');
    }

    const walletMode = this.resolveWalletMode(task);

    this.logger.log(
      `[execution-router] taskId=${task.id} type=${task.type} walletMode=${walletMode}`,
    );

    return this.agentRouter.execute(task.type as TaskType, task);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extract walletMode from the task payload.
   * Defaults to "EXTERNAL_WALLET" when absent. Any other value fails closed.
   */
  private resolveWalletMode(task: TaskDetails): 'EXTERNAL_WALLET' {
    const raw = task.payload?.walletMode;

    if (raw === undefined || raw === null || raw === 'EXTERNAL_WALLET') {
      return 'EXTERNAL_WALLET';
    }

    throw new BadRequestException(
      `Unsupported walletMode "${String(raw)}". Only "EXTERNAL_WALLET" is supported on Arc Mainnet.`,
    );
  }
}
