import { Injectable, Logger } from '@nestjs/common';
import { WindDownState } from './fx.types';

/**
 * Minimum withdrawal window duration in milliseconds (7 days).
 */
export const WIND_DOWN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Depositor information used to initialize the wind-down process.
 */
export interface DepositorInfo {
  address: string;
  token: string;
  shares: string;
}

/**
 * Pool ledger entry representing the total balance of a token in the pool.
 */
export interface PoolLedgerEntry {
  token: string;
  balance: string;
}

/**
 * Transfer function signature for executing withdrawals.
 * Returns true on success, throws or returns false on failure.
 */
export type TransferFn = (
  depositor: string,
  token: string,
  amount: string,
) => Promise<boolean>;

/**
 * Notification function signature for notifying depositors.
 */
export type NotifyFn = (
  depositor: string,
  token: string,
  proRataAmount: string,
  withdrawalWindowEnd: string,
) => Promise<void>;

/**
 * Event emitted when a wind-down diagnostic occurs.
 */
export interface WindDownDiagnosticEvent {
  type: 'withdrawal_failure';
  depositor: string;
  token: string;
  reason: string;
  timestamp: string;
}

/**
 * LpWindDownService manages the orderly wind-down of the deprecated
 * StableFXAdapter_V2 LP system. It calculates pro-rata shares for each
 * depositor, enforces a minimum 7-day withdrawal window, and handles
 * failure scenarios by halting the sequence and blocking deprecation.
 *
 * Requirements: 1.4, 1.5, 1.6, 9.8, 9.9
 */
@Injectable()
export class LpWindDownService {
  private readonly logger = new Logger(LpWindDownService.name);
  private state: WindDownState;
  private diagnosticEvents: WindDownDiagnosticEvent[] = [];
  private halted = false;

  /** Injected transfer function for executing on-chain withdrawals. */
  private transferFn: TransferFn | null = null;

  /** Injected notification function for notifying depositors. */
  private notifyFn: NotifyFn | null = null;

  constructor() {
    this.state = {
      initiated: false,
      depositors: [],
      totalSupplyAtStart: '0',
      currentTotalSupply: '0',
      complete: false,
    };
  }

  /**
   * Set the transfer function used to execute on-chain withdrawals.
   */
  setTransferFn(fn: TransferFn): void {
    this.transferFn = fn;
  }

  /**
   * Set the notification function used to notify depositors.
   */
  setNotifyFn(fn: NotifyFn): void {
    this.notifyFn = fn;
  }

  /**
   * Initiates the LP wind-down process.
   *
   * Calculates pro-rata shares for each depositor based on:
   *   proRataAmount = depositor_shares / totalSupply × poolLedger[token]
   *
   * Sets a withdrawal window of at least 7 days from initiation.
   * Notifies all depositors of their withdrawal amounts and window.
   *
   * @param depositors - Array of depositor information (address, token, shares)
   * @param poolLedger - Array of pool ledger entries (token, balance)
   * @param totalSupply - Total supply of SFX-LP tokens
   */
  async initiateWindDown(
    depositors: DepositorInfo[],
    poolLedger: PoolLedgerEntry[],
    totalSupply: string,
  ): Promise<void> {
    if (this.state.initiated) {
      throw new Error('Wind-down already initiated');
    }

    const totalSupplyNum = parseFloat(totalSupply);
    if (totalSupplyNum <= 0 || isNaN(totalSupplyNum)) {
      throw new Error(
        `Invalid totalSupply: ${totalSupply}. Must be a positive number.`,
      );
    }

    const now = new Date();
    const initiatedAt = now.toISOString();
    const withdrawalWindowEnd = new Date(
      now.getTime() + WIND_DOWN_WINDOW_MS,
    ).toISOString();

    // Build a lookup map for pool ledger balances by token
    const poolBalanceByToken = new Map<string, number>();
    for (const entry of poolLedger) {
      poolBalanceByToken.set(entry.token, parseFloat(entry.balance));
    }

    // Calculate pro-rata amounts for each depositor
    const calculatedDepositors = depositors.map((dep) => {
      const shares = parseFloat(dep.shares);
      const poolBalance = poolBalanceByToken.get(dep.token) ?? 0;
      const proRataAmount = (shares / totalSupplyNum) * poolBalance;

      return {
        address: dep.address,
        token: dep.token,
        shares: dep.shares,
        proRataAmount: proRataAmount.toString(),
        withdrawn: false,
      };
    });

    this.state = {
      initiated: true,
      initiatedAt,
      withdrawalWindowEnd,
      depositors: calculatedDepositors,
      totalSupplyAtStart: totalSupply,
      currentTotalSupply: totalSupply,
      complete: false,
    };

    this.halted = false;
    this.diagnosticEvents = [];

    this.logger.log(
      `[lp-wind-down] Wind-down initiated. totalSupply=${totalSupply}, ` +
        `depositors=${depositors.length}, withdrawalWindowEnd=${withdrawalWindowEnd}`,
    );

    // Notify all depositors
    for (const dep of calculatedDepositors) {
      if (this.notifyFn) {
        await this.notifyFn(
          dep.address,
          dep.token,
          dep.proRataAmount,
          withdrawalWindowEnd,
        );
      }
      this.logger.log(
        `[lp-wind-down] Notified depositor ${dep.address}: ` +
          `token=${dep.token}, proRataAmount=${dep.proRataAmount}`,
      );
    }
  }

  /**
   * Executes a withdrawal for a specific depositor and token.
   *
   * Transfers the pro-rata amount to the depositor and reduces currentTotalSupply.
   * On failure: halts the entire wind-down sequence, emits a diagnostic event,
   * and blocks contract deprecation.
   *
   * @param depositor - The depositor's address
   * @param token - The token to withdraw
   */
  async executeWithdrawal(depositor: string, token: string): Promise<void> {
    if (!this.state.initiated) {
      throw new Error('Wind-down has not been initiated');
    }

    if (this.halted) {
      throw new Error(
        'Wind-down sequence is halted due to a previous withdrawal failure. ' +
          'Manual intervention required.',
      );
    }

    // Find the depositor entry
    const entry = this.state.depositors.find(
      (d) => d.address === depositor && d.token === token,
    );

    if (!entry) {
      throw new Error(
        `Depositor ${depositor} with token ${token} not found in wind-down state`,
      );
    }

    if (entry.withdrawn) {
      throw new Error(
        `Depositor ${depositor} has already withdrawn token ${token}`,
      );
    }

    // Attempt the transfer
    try {
      if (!this.transferFn) {
        throw new Error('Transfer function not configured');
      }

      const success = await this.transferFn(
        depositor,
        token,
        entry.proRataAmount,
      );

      if (!success) {
        throw new Error(
          `Transfer returned false for depositor ${depositor}, token ${token}`,
        );
      }
    } catch (error) {
      // On failure: halt entire sequence, emit diagnostic event, block deprecation
      const reason =
        error instanceof Error ? error.message : 'Unknown transfer failure';

      this.halted = true;
      entry.failureReason = reason;

      const diagnosticEvent: WindDownDiagnosticEvent = {
        type: 'withdrawal_failure',
        depositor,
        token,
        reason,
        timestamp: new Date().toISOString(),
      };
      this.diagnosticEvents.push(diagnosticEvent);

      this.logger.error(
        `[lp-wind-down] Withdrawal FAILED for depositor ${depositor}, ` +
          `token=${token}. Halting wind-down sequence. Reason: ${reason}`,
      );

      throw new Error(
        `Wind-down halted: withdrawal failed for depositor ${depositor}, ` +
          `token ${token}. Reason: ${reason}. Contract deprecation blocked.`,
      );
    }

    // Success: mark as withdrawn and reduce currentTotalSupply
    entry.withdrawn = true;
    const currentSupply = parseFloat(this.state.currentTotalSupply);
    const shares = parseFloat(entry.shares);
    const newSupply = currentSupply - shares;
    this.state.currentTotalSupply = Math.max(0, newSupply).toString();

    // Check if wind-down is complete
    if (parseFloat(this.state.currentTotalSupply) === 0) {
      this.state.complete = true;
    }

    this.logger.log(
      `[lp-wind-down] Withdrawal successful for depositor ${depositor}, ` +
        `token=${token}, amount=${entry.proRataAmount}. ` +
        `currentTotalSupply=${this.state.currentTotalSupply}`,
    );
  }

  /**
   * Returns the current wind-down state.
   */
  async getWindDownStatus(): Promise<WindDownState> {
    return { ...this.state, depositors: [...this.state.depositors] };
  }

  /**
   * Returns true when the wind-down is complete (currentTotalSupply == "0").
   */
  isWindDownComplete(): boolean {
    return (
      this.state.initiated && parseFloat(this.state.currentTotalSupply) === 0
    );
  }

  /**
   * Returns whether the wind-down sequence is halted due to a failure.
   */
  isHalted(): boolean {
    return this.halted;
  }

  /**
   * Returns all diagnostic events emitted during the wind-down.
   */
  getDiagnosticEvents(): WindDownDiagnosticEvent[] {
    return [...this.diagnosticEvents];
  }

  /**
   * Checks whether contract deprecation is allowed.
   *
   * Deprecation is blocked if:
   * - Wind-down is halted (withdrawal failure occurred)
   * - Residual deposits remain (currentTotalSupply > 0) after withdrawal window
   *
   * @returns true if deprecation is allowed, false otherwise
   */
  canDeprecateContract(): boolean {
    if (!this.state.initiated) {
      return false;
    }

    // Block if halted due to withdrawal failure
    if (this.halted) {
      this.logger.warn(
        '[lp-wind-down] Deprecation blocked: wind-down halted due to withdrawal failure.',
      );
      return false;
    }

    // Block if residual deposits remain after withdrawal window
    if (parseFloat(this.state.currentTotalSupply) > 0) {
      this.logger.warn(
        `[lp-wind-down] Deprecation blocked: residual deposits remain. ` +
          `currentTotalSupply=${this.state.currentTotalSupply}`,
      );
      return false;
    }

    return true;
  }
}
