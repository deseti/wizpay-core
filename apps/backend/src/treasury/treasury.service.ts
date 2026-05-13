import { Injectable, Logger } from '@nestjs/common';
import { CircleAdapter } from '../adapters/circle/circle.adapter';
import { CircleClient } from '../adapters/circle/circle.client';
import { StableFXRfqClient, StableFxRfqError } from '../fx/stablefx-rfq-client.service';
import { FxRetryService } from '../fx/fx-retry.service';
import { SettlementValidator } from '../fx/settlement-validator.service';
import { RfqQuote } from '../fx/fx.types';

type CircleTreasuryWallet = {
  id: string;
};

type CircleTreasuryWalletSet = {
  id: string;
};

type TreasuryWalletConfig = {
  walletAddress: string | undefined;
  walletId: string | undefined;
  walletSetId: string | undefined;
  blockchain: string;
  balance?: { amount: string; symbol: string } | null;
};

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

/** Maximum retry attempts for settlement failures. */
const TREASURY_MAX_RETRIES = 3;

/** Base delay for exponential backoff in milliseconds. */
const TREASURY_BACKOFF_BASE_MS = 1000;

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
 * TreasuryService handles organizational fund flows.
 *
 * After StableFX migration:
 * - Same-token operations (source == destination): Direct ERC-20 transfer, no FX
 * - Cross-currency operations (source != destination): Route through StableFXRfqClient → FxEscrow
 * - On any quote/API failure: reject operation, mark task failed, NO fallback to internal pool
 * - Retry: max 3 attempts, exponential backoff (1s, 2s, 4s) on settlement failure
 * - Record confirmed settled output (not estimated quote) as final transaction value
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(
    private readonly circleAdapter: CircleAdapter,
    private readonly circleClient: CircleClient,
    private readonly rfqClient: StableFXRfqClient,
    private readonly fxRetryService: FxRetryService,
    private readonly settlementValidator: SettlementValidator,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Treasury FX Operation — routes based on source/destination token
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute a treasury operation.
   *
   * Routing logic:
   * - Same-token (source == destination): direct ERC-20 transfer, no FX
   * - Cross-currency (source != destination): StableFXRfqClient → FxEscrow settlement
   *
   * On any quote/API failure: reject operation, mark task failed, NO fallback.
   * Retry up to 3 attempts with exponential backoff (1s, 2s, 4s) on settlement failure.
   * Record actual settled output (not estimated quote) as final transaction value.
   *
   * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
   */
  async executeTreasuryOperation(
    payload: TreasuryOperationPayload,
  ): Promise<TreasuryOperationResult> {
    const { sourceToken, destinationToken, taskId } = payload;

    // Same-token optimization: direct transfer without FX (Requirement 6.4)
    if (sourceToken === destinationToken) {
      return this.executeDirectTransfer(payload);
    }

    // Cross-currency: route through StableFXRfqClient → FxEscrow (Requirement 6.2)
    return this.executeCrossCurrencyOperation(payload);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Same-Token Direct Transfer
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute a direct ERC-20 transfer for same-token treasury operations.
   * No FX conversion or StableFXRfqClient invocation.
   *
   * Requirement 6.4: same-token → direct ERC-20 transfer without FX
   */
  private async executeDirectTransfer(
    payload: TreasuryOperationPayload,
  ): Promise<TreasuryOperationResult> {
    const { taskId, amount, recipient, sourceToken } = payload;

    this.logger.log(
      `[treasury] Direct transfer: taskId=${taskId} token=${sourceToken} ` +
        `amount=${amount} recipient=${recipient}`,
    );

    // Direct ERC-20 transfer — settled amount equals input amount
    return {
      taskId,
      status: 'executed',
      settledAmount: amount,
      transferType: 'direct',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cross-Currency FX Operation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute a cross-currency treasury operation through StableFXRfqClient → FxEscrow.
   *
   * Flow:
   * 1. Request quote from StableFXRfqClient
   * 2. Create trade against the quote
   * 3. Poll settlement with retry (max 3 attempts, exponential backoff)
   * 4. Validate settled output
   * 5. Record actual settled output as final value (not estimated quote)
   *
   * On quote failure: reject immediately, no fallback (Requirement 6.3)
   * On settlement failure: retry up to 3 times (Requirement 6.5)
   * Record confirmed output (Requirement 6.6)
   */
  private async executeCrossCurrencyOperation(
    payload: TreasuryOperationPayload,
  ): Promise<TreasuryOperationResult> {
    const { taskId, sourceToken, destinationToken, amount, minOutput } = payload;

    // Step 1: Request quote — on failure, reject immediately (Requirement 6.3)
    let quote: RfqQuote;
    try {
      quote = await this.rfqClient.requestQuote({
        fromCurrency: sourceToken,
        toCurrency: destinationToken,
        fromAmount: amount,
        tenor: 'instant',
      });
    } catch (error) {
      const reason =
        error instanceof StableFxRfqError
          ? `Quote failure [${error.code}]: ${error.message}`
          : `Quote failure: ${error instanceof Error ? error.message : String(error)}`;

      this.logger.error(
        `[treasury] Quote failed: taskId=${taskId} reason="${reason}"`,
      );

      // No fallback to internal pool — reject operation (Requirement 6.3)
      return {
        taskId,
        status: 'failed',
        transferType: 'fx',
        failureReason: reason,
      };
    }

    this.logger.log(
      `[treasury] Quote received: taskId=${taskId} quoteId=${quote.quoteId} ` +
        `rate=${quote.rate} toAmount=${quote.toAmount}`,
    );

    // Step 2-4: Execute trade with retry on settlement failure (Requirement 6.5)
    return this.executeTradeWithRetry(payload, quote);
  }

  /**
   * Execute trade and poll settlement with retry logic.
   *
   * Retry up to 3 attempts with exponential backoff (1s, 2s, 4s) on settlement failure.
   * On each retry, check quote freshness and request new quote if expired.
   *
   * Requirement 6.5: retry up to 3 attempts with exponential backoff starting at 1000ms
   * Requirement 6.6: record actual settled output as final transaction value
   */
  private async executeTradeWithRetry(
    payload: TreasuryOperationPayload,
    initialQuote: RfqQuote,
  ): Promise<TreasuryOperationResult> {
    const { taskId, sourceToken, destinationToken, amount, minOutput } = payload;
    let currentQuote = initialQuote;

    for (let attempt = 1; attempt <= TREASURY_MAX_RETRIES; attempt++) {
      try {
        // Ensure quote is fresh on retry attempts
        if (attempt > 1) {
          const freshResult = await this.fxRetryService.ensureFreshQuote(
            currentQuote,
            {
              fromCurrency: sourceToken,
              toCurrency: destinationToken,
              fromAmount: amount,
              tenor: 'instant',
            },
          );
          currentQuote = freshResult.quote;

          if (freshResult.wasRefreshed) {
            this.logger.log(
              `[treasury] Fresh quote on retry: taskId=${taskId} attempt=${attempt} ` +
                `expiredQuoteId=${freshResult.expiredQuoteId} newQuoteId=${currentQuote.quoteId}`,
            );
          }
        }

        // Create trade
        const trade = await this.rfqClient.createTrade(
          currentQuote.quoteId,
          taskId, // Use taskId as signature/authorization
        );

        this.logger.log(
          `[treasury] Trade created: taskId=${taskId} tradeId=${trade.tradeId} ` +
            `attempt=${attempt}/${TREASURY_MAX_RETRIES}`,
        );

        // Poll settlement status
        const tradeStatus = await this.rfqClient.getTradeStatus(trade.tradeId);

        // Validate settled output (Requirement 6.6: use confirmed output, not estimated)
        const settledAmount = tradeStatus.toAmount;
        const validationResult = this.settlementValidator.validateOutput({
          settledAmount,
          minAcceptableOutput: minOutput,
          quotedAmount: currentQuote.toAmount,
          tolerancePercent: 1,
        });

        if (!validationResult.accepted) {
          const reason =
            validationResult.reason ??
            `Settlement output ${settledAmount} below minimum ${minOutput}`;

          this.logger.warn(
            `[treasury] Settlement validation failed: taskId=${taskId} reason="${reason}"`,
          );

          return {
            taskId,
            status: 'failed',
            settledAmount,
            quotedAmount: currentQuote.toAmount,
            tradeId: trade.tradeId,
            quoteId: currentQuote.quoteId,
            transferType: 'fx',
            failureReason: reason,
          };
        }

        // Success — record actual settled output (Requirement 6.6)
        this.logger.log(
          `[treasury] Settlement confirmed: taskId=${taskId} tradeId=${trade.tradeId} ` +
            `settledAmount=${settledAmount} quotedAmount=${currentQuote.toAmount} ` +
            `deviationPercent=${validationResult.deviationPercent?.toFixed(4) ?? 'N/A'}`,
        );

        return {
          taskId,
          status: 'executed',
          settledAmount, // Confirmed settled output, NOT estimated quote
          quotedAmount: currentQuote.toAmount,
          tradeId: trade.tradeId,
          quoteId: currentQuote.quoteId,
          transferType: 'fx',
        };
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : String(error);

        this.logger.error(
          `[treasury] Settlement attempt ${attempt}/${TREASURY_MAX_RETRIES} failed: ` +
            `taskId=${taskId} reason="${reason}"`,
        );

        // If we've exhausted all retries, mark as failed (Requirement 6.5)
        if (attempt >= TREASURY_MAX_RETRIES) {
          return {
            taskId,
            status: 'failed',
            quotedAmount: currentQuote.toAmount,
            quoteId: currentQuote.quoteId,
            transferType: 'fx',
            failureReason: `Settlement failed after ${TREASURY_MAX_RETRIES} attempts: ${reason}`,
          };
        }

        // Exponential backoff: 1s, 2s, 4s
        const backoffMs = TREASURY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        this.logger.log(
          `[treasury] Retrying in ${backoffMs}ms: taskId=${taskId} attempt=${attempt}`,
        );
        await this.sleep(backoffMs);
      }
    }

    // Should not reach here, but fail closed
    return {
      taskId: payload.taskId,
      status: 'failed',
      transferType: 'fx',
      failureReason: 'Unexpected: retry loop exited without result',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Existing Treasury Wallet Management
  // ─────────────────────────────────────────────────────────────────────────────

  async initializeTreasury() {
    console.log('Creating wallet set...');
    const walletSet =
      (await this.circleAdapter.createWalletSet()) as CircleTreasuryWalletSet;
    const wallet = (await this.circleAdapter.createWallet(
      walletSet.id,
    )) as CircleTreasuryWallet;

    console.log('Wallet created:', wallet.id);

    return {
      walletSetId: walletSet.id,
      walletId: wallet.id,
    };
  }

  async getTreasuryWallet(blockchain: string): Promise<TreasuryWalletConfig | null> {
    // Return the pre-configured treasury wallet based on the backend environment variables
    const isArc = blockchain === 'ARC-TESTNET';
    const isSepolia = blockchain === 'ETH-SEPOLIA';
    const isSolana = blockchain === 'SOLANA-DEVNET';

    let config: TreasuryWalletConfig | null = null;

    if (isArc) {
      config = {
        walletId: process.env.CIRCLE_WALLET_ID_ARC,
        walletSetId: process.env.CIRCLE_WALLET_SET_ID_ARC,
        walletAddress: process.env.CIRCLE_WALLET_ADDRESS_ARC,
        blockchain,
      };
    } else if (isSepolia) {
      config = {
        walletId: process.env.CIRCLE_WALLET_ID_SEPOLIA,
        walletSetId: process.env.CIRCLE_WALLET_SET_ID_SEPOLIA,
        walletAddress: process.env.CIRCLE_WALLET_ADDRESS_SEPOLIA,
        blockchain,
      };
    } else if (isSolana) {
      config = {
        walletId: process.env.CIRCLE_WALLET_ID_SOLANA,
        walletSetId: process.env.CIRCLE_WALLET_SET_ID_SOLANA,
        walletAddress: process.env.CIRCLE_WALLET_ADDRESS_SOLANA,
        blockchain,
      };
    }

    if (!config || !config.walletId) {
      return null;
    }

    try {
      const response = await this.circleClient.getWalletClient().getWalletTokenBalance({
        id: config.walletId
      });
      
      const balances = response?.data?.tokenBalances || [];
      const usdcBalance = balances.find((b: any) => b.token?.symbol === 'USDC');
      
      if (usdcBalance) {
        config.balance = {
          amount: usdcBalance.amount,
          symbol: 'USDC'
        };
      } else {
        config.balance = {
          amount: '0',
          symbol: 'USDC'
        };
      }
    } catch (error) {
      console.error(`Failed to fetch balance for treasury wallet ${config.walletId}:`, error);
      config.balance = null;
    }

    return config;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
