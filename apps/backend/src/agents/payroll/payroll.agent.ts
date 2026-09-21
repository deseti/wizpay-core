import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import type { TaskDetails } from '../../task/task.types';
import type { AgentExecutionResult, TaskAgent } from '../agent.interface';
import { PayrollValidationService } from './payroll-validation.service';

// ─── Agent ──────────────────────────────────────────────────────────

/**
 * PayrollAgent — Mainnet direct payroll validation boundary.
 *
 * Backend submission of payroll transfers is retired on Arc Mainnet: the
 * legacy path submitted transfers through hosted wallets and
 * polled a provider for confirmation. That path no longer exists.
 *
 * The Mainnet flow is:
 *   1. Validate recipients with PayrollValidationService (Mainnet direct,
 *      same-token USDC/EURC rules).
 *   2. Plan batches with PayrollBatchService via /tasks/payroll/init.
 *   3. Execute transfers from the external wallet.
 *   4. Report each unit hash for on-chain receipt verification.
 *
 * When this agent is invoked with a valid payload it fails closed with
 * PAYROLL_BACKEND_SUBMISSION_UNAVAILABLE before any side effect, directing
 * callers to the external-wallet flow. Invalid payloads fail fast with a
 * validation error so misconfigured payroll drafts surface immediately.
 */
@Injectable()
export class PayrollAgent implements TaskAgent {
  private readonly logger = new Logger(PayrollAgent.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly validationService: PayrollValidationService,
  ) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    this.logger.log(`Payroll agent executing — taskId=${task.id}`);

    // ── Idempotency: skip if task already has submissions ──────────
    if (task.result && typeof task.result === 'object' && 'agent' in task.result) {
      this.logger.warn(
        `Payroll task ${task.id} already has a result — returning existing (idempotent)`,
      );
      return task.result as AgentExecutionResult;
    }

    // ── Step 1: Validate (Mainnet direct) ──────────────────────────
    const validation = await this.validationService.validate(task.payload);

    if (!validation.valid) {
      const errorMessages = validation.errors.join('; ');
      this.logger.warn(
        `Validation failed — taskId=${task.id} errors="${errorMessages}"`,
      );
      throw new BadRequestException(
        `Payroll validation failed: ${errorMessages}`,
      );
    }

    await this.taskService.logStep(
      task.id,
      'payroll.validated',
      TaskStatus.IN_PROGRESS,
      `Validated ${validation.recipients.length} recipients`,
    );

    // ── Step 2: Fail closed — no backend submission on Mainnet ─────
    this.logger.warn(
      `[payroll-agent] Refused payroll task ${task.id}: backend transfer submission is retired on Arc Mainnet.`,
    );
    throw new ServiceUnavailableException({
      code: 'PAYROLL_BACKEND_SUBMISSION_UNAVAILABLE',
      message:
        'Backend payroll submission is retired on Arc Mainnet. Plan with /tasks/payroll/init, execute transfers from the external wallet, then report each unit transaction hash.',
    });
  }
}
