import { Injectable, Logger } from '@nestjs/common';
import { AgentRouterService } from '../agents/agent-router.service';
import { AgentExecutionResult } from '../agents/agent.interface';
import { TaskType } from '../task/task-type.enum';
import { TaskDetails, WalletMode } from '../task/task.types';
import { PasskeyEngineService } from './passkey-engine.service';

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * ExecutionRouterService — central dispatch for ALL task execution.
 *
 * This is the single entry point called by OrchestratorService.
 * No agent, worker, or controller should call execution engines directly.
 *
 * Routing logic
 * ─────────────
 *  task.payload.walletMode === "PASSKEY"
 *    → PasskeyEngineService  (no userToken / tokenId / createTransferChallenge)
 *
 *  task.payload.walletMode === "W3S"  |  absent (default)
 *    → AgentRouterService  (existing Circle W3S flow, UNCHANGED)
 *
 * Backward compatibility
 * ──────────────────────
 *  When walletMode is absent the router defaults to "W3S".
 *  Every existing task that was created before walletMode was introduced
 *  will continue to work exactly as before — zero breaking changes.
 *
 * Adding new wallet modes
 * ───────────────────────
 *  Extend the WalletMode union in task.types.ts and add a new case here.
 *  Neither agents nor OrchestratorService need to change.
 */
@Injectable()
export class ExecutionRouterService {
  private readonly logger = new Logger(ExecutionRouterService.name);

  constructor(
    private readonly agentRouter: AgentRouterService,
    private readonly passkeyEngine: PasskeyEngineService,
  ) {}

  /**
   * Route a task to the correct execution engine based on walletMode.
   *
   * @param task - Full task record including payload and logs.
   * @returns AgentExecutionResult — structure is engine-specific but
   *          always matches the shape expected by OrchestratorService.
   */
  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    const walletMode = this.resolveWalletMode(task);

    this.logger.log(
      `[execution-router] taskId=${task.id} type=${task.type} walletMode=${walletMode}`,
    );

    if (walletMode === 'PASSKEY') {
      return this.passkeyEngine.execute(task);
    }

    // Default: W3S — delegate to existing AgentRouterService untouched.
    return this.agentRouter.execute(task.type as TaskType, task);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extract walletMode from the task payload.
   * Defaults to "W3S" when absent so existing tasks are unaffected.
   */
  private resolveWalletMode(task: TaskDetails): WalletMode {
    const raw = task.payload?.walletMode;

    if (raw === 'PASSKEY') {
      return 'PASSKEY';
    }

    // Treat any other value (including undefined / null / "W3S") as W3S.
    return 'W3S';
  }
}
