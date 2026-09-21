import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

// ─── Types ──────────────────────────────────────────────────────────

export interface FxSettlementRequest {
  provider: string;
  sourceToken: string;
  targetToken: string;
  /** Human-readable aggregate amount in source token (e.g. "1500.00") */
  sourceAmount: string;
  routingAmount: string;
  /** Wallet address of the sender (informational, not used for execution) */
  walletAddress?: string;
  /** Idempotency reference for this settlement */
  referenceId: string;
}

export interface FxSettlementResult {
  sourceToken: string;
  targetToken: string;
  sourceAmount: string;
  targetAmount: string;
  txHash: string | null;
  status: 'settled' | 'failed';
}

// ─── Service ────────────────────────────────────────────────────────

/**
 * PayrollFxSettlementService is the Mainnet boundary for aggregate
 * cross-currency payroll settlement.
 *
 * Backend-submitted aggregate settlement is retired on Arc Mainnet:
 * cross-currency conversion is priced by Uniswap V4 and executed by the
 * external wallet against WizPaySwapExecutorMainnet. The backend never
 * submits settlement transactions and never proxies provider quotes.
 *
 * Fail-closed: every settlement request is rejected with an explicit
 * unavailable error before any side effect.
 */
@Injectable()
export class PayrollFxSettlementService {
  private readonly logger = new Logger(PayrollFxSettlementService.name);

  /**
   * Aggregate settlement is never available via backend submission.
   */
  isSettlementAvailable(): boolean {
    return false;
  }

  /**
   * Reject every aggregate FX settlement request without side effects.
   */
  async settle(request: FxSettlementRequest): Promise<FxSettlementResult> {
    this.logger.warn(
      `Payroll FX settlement refused — ${request.sourceToken} -> ${request.targetToken} ` +
        `amount=${request.sourceAmount} ref=${request.referenceId}`,
    );
    throw new ServiceUnavailableException({
      code: 'PAYROLL_FX_SETTLEMENT_UNAVAILABLE',
      message:
        'Aggregate payroll FX settlement is unavailable. Settle cross-currency payroll through the external-wallet Uniswap V4 flow before submitting same-token payroll.',
    });
  }
}
