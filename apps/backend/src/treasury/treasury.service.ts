import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Payload for a treasury FX operation.
 */
export interface TreasuryOperationPayload {
  sourceToken: string;
  destinationToken: string;
  amount: string;
  minOutput: string;
  recipient: string;
  taskId: string;
}

/**
 * Result of a treasury operation execution.
 */
export interface TreasuryOperationResult {
  taskId: string;
  status: 'executed' | 'failed';
  settledAmount?: string;
  quotedAmount?: string;
  tradeId?: string;
  quoteId?: string;
  transferType: 'direct' | 'fx';
  failureReason?: string;
}

/**
 * Error thrown when a treasury operation fails and cannot be retried.
 */
export class TreasuryOperationError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(reason);
    this.name = 'TreasuryOperationError';
  }
}

/**
 * TreasuryService describes organizational fund flows on Arc Mainnet.
 *
 * Mainnet is external-wallet-only: the backend never moves treasury funds.
 * Same-token and cross-currency operations alike fail closed so no transfer
 * is submitted, queued, or recorded as executed by the backend.
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  /**
   * Refuse every treasury operation without side effects.
   *
   * Routing logic:
   * - Same-token (source == destination): refused, no direct transfer submitted
   * - Cross-currency (source != destination): refused, no conversion submitted
   */
  async executeTreasuryOperation(
    payload: TreasuryOperationPayload,
  ): Promise<TreasuryOperationResult> {
    const { sourceToken, destinationToken, taskId } = payload;

    this.logger.warn(
      `[treasury] Refused treasury operation: taskId=${taskId} token=${sourceToken} ` +
        `destination=${destinationToken}. Backend fund movement is retired on Arc Mainnet.`,
    );

    throw new ServiceUnavailableException({
      code: 'TREASURY_OPERATION_UNAVAILABLE',
      message:
        'Treasury operations cannot execute from the backend on Arc Mainnet. Move funds through the external wallet.',
    });
  }

  /**
   * Treasury initialization is retired: the backend provisions no wallets.
   */
  async initializeTreasury(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'TREASURY_INITIALIZATION_UNAVAILABLE',
      message:
        'Treasury initialization is retired on Arc Mainnet. The backend provisions no wallets.',
    });
  }

  /**
   * Mainnet read-only boundary: the backend tracks no treasury wallet.
   */
  async getTreasuryWallet(blockchain: string): Promise<null> {
    this.logger.debug(
      `[treasury] No backend treasury wallet is tracked for blockchain=${blockchain}.`,
    );
    return null;
  }
}
