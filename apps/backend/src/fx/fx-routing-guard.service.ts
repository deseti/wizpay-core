import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_WINDOW,
} from './fx.constants';

/**
 * Valid routing modes for the FX feature flag.
 */
export type FxMode = 'legacy' | 'new';

/**
 * A single outcome entry in the circuit breaker rolling window.
 */
export interface OutcomeEntry {
  timestamp: string;
  success: boolean;
  operationId: string;
}

/**
 * FxRoutingGuard controls routing for FX operations on Arc Mainnet.
 *
 * Mainnet is provider-only: the active mode is always 'new'. The legacy
 * backend execution path is retired, so requesting or selecting 'legacy'
 * fails closed. The guard maintains a rolling window of operation outcomes
 * for circuit breaker logic and emits operator alerts when the circuit opens.
 */
@Injectable()
export class FxRoutingGuard {
  private readonly logger = new Logger(FxRoutingGuard.name);

  /**
   * In-memory mode state. Initialized from ConfigService on first access.
   * In production, this would be backed by a database for persistence across restarts.
   */
  private currentMode: FxMode | undefined;

  /**
   * Rolling window of recent operation outcomes for circuit breaker evaluation.
   * Capped at CIRCUIT_BREAKER_WINDOW (20) entries.
   */
  private readonly outcomes: OutcomeEntry[] = [];

  /**
   * Whether the circuit breaker is currently open.
   * Once open, it stays open until an operator explicitly resets (via setMode).
   */
  private circuitOpen = false;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns the active routing mode.
   *
   * Always 'new' on Arc Mainnet. Throws when FX_ROUTING_MODE is set to
   * 'legacy' or to any value other than 'new', because backend execution
   * paths are retired.
   *
   * @throws Error if mode is not exactly 'new' (or unset, which defaults to 'new')
   */
  getActiveMode(): FxMode {
    if (this.currentMode === undefined) {
      const configValue = this.configService.get<string>('FX_ROUTING_MODE');
      if (configValue === undefined || configValue === 'new') {
        this.currentMode = 'new';
      } else {
        throw new ServiceUnavailableException(
          `FX routing configuration is unavailable: mode is "${configValue ?? 'unset'}". ` +
            `Only "new" is supported on Arc Mainnet; backend execution paths are retired.`,
        );
      }
    }

    return this.currentMode;
  }

  /**
   * Sets the active routing mode.
   *
   * Only 'new' is accepted on Arc Mainnet. Logs the previous value, new
   * value, operator identity, and timestamp. Resets the circuit breaker
   * when mode is changed (operator acknowledgment).
   *
   * @param mode - The new routing mode (must be 'new')
   * @param operatorId - Identity of the operator making the change
   * @throws Error if mode is not exactly 'new'
   */
  setMode(mode: FxMode, operatorId: string): void {
    if (mode !== 'new') {
      throw new ServiceUnavailableException(
        `Invalid FX routing mode: "${mode}". Only "new" is supported on Arc Mainnet.`,
      );
    }

    const previousMode = this.currentMode ?? 'unset';
    const timestamp = new Date().toISOString();

    this.logger.log(
      `[fx-routing-guard] Mode change: "${previousMode}" → "${mode}" ` +
        `by operator="${operatorId}" at ${timestamp}`,
    );

    this.currentMode = mode;

    // Operator changing the mode acts as circuit breaker acknowledgment
    if (this.circuitOpen) {
      this.logger.log(
        `[fx-routing-guard] Circuit breaker reset by operator="${operatorId}" at ${timestamp}`,
      );
      this.circuitOpen = false;
    }
  }

  /**
   * Records the outcome of an FX operation for circuit breaker evaluation.
   *
   * Appends to the rolling window (capped at CIRCUIT_BREAKER_WINDOW entries).
   * After recording, evaluates whether the circuit should open.
   *
   * @param mode - The routing mode under which the operation was executed
   * @param success - Whether the operation succeeded
   */
  recordOutcome(mode: string, success: boolean): void {
    const entry: OutcomeEntry = {
      timestamp: new Date().toISOString(),
      success,
      operationId: this.generateOperationId(),
    };

    this.outcomes.push(entry);

    // Trim to rolling window size
    while (this.outcomes.length > CIRCUIT_BREAKER_WINDOW) {
      this.outcomes.shift();
    }

    // Only evaluate circuit breaker for 'new' path
    if (mode === 'new' && !success) {
      this.evaluateCircuitBreaker();
    }
  }

  /**
   * Returns whether the circuit breaker is currently open.
   *
   * The circuit opens when CIRCUIT_BREAKER_THRESHOLD (3) or more failures
   * exist in the most recent CIRCUIT_BREAKER_WINDOW (20) operations on the 'new' path.
   */
  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /**
   * Returns the current rolling window of outcomes (for testing/inspection).
   */
  getOutcomes(): ReadonlyArray<OutcomeEntry> {
    return this.outcomes;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Evaluates whether the circuit breaker should open based on
   * the failure count in the rolling window.
   */
  private evaluateCircuitBreaker(): void {
    const failureCount = this.outcomes.filter((o) => !o.success).length;

    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD && !this.circuitOpen) {
      this.circuitOpen = true;
      this.emitCircuitOpenAlert(failureCount);
    }
  }

  /**
   * Emits an operator alert when the circuit breaker opens.
   */
  private emitCircuitOpenAlert(failureCount: number): void {
    const timestamp = new Date().toISOString();

    this.logger.error(
      `[fx-routing-guard] CIRCUIT BREAKER OPEN — ` +
        `${failureCount} failures in last ${this.outcomes.length} operations. ` +
        `New FX operations on "new" path are halted. ` +
        `Operator acknowledgment required. timestamp=${timestamp}`,
    );
  }

  /**
   * Generates a unique operation ID for outcome tracking.
   */
  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
