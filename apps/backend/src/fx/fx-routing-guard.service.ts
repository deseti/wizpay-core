import { Injectable, Logger } from '@nestjs/common';
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
 * FxRoutingGuard controls routing between legacy (StableFXAdapter_V2)
 * and new (Circle StableFX RFQ) paths.
 *
 * Responsibilities:
 * - Read/write the active routing mode (feature flag)
 * - Maintain a rolling window of operation outcomes for circuit breaker logic
 * - Open the circuit when failure threshold is exceeded
 * - Emit operator alerts when circuit opens
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
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
   * Reads from in-memory state (initialized from config on first call).
   * Throws if the mode is unset, missing, or contains an invalid value.
   *
   * @throws Error if mode is not exactly 'legacy' or 'new'
   */
  getActiveMode(): FxMode {
    if (this.currentMode === undefined) {
      const configValue = this.configService.get<string>('FX_ROUTING_MODE');
      if (configValue === 'legacy' || configValue === 'new') {
        this.currentMode = configValue;
      } else {
        throw new Error(
          `FX routing configuration is unavailable: mode is "${configValue ?? 'unset'}". ` +
            `Expected exactly "legacy" or "new".`,
        );
      }
    }

    return this.currentMode;
  }

  /**
   * Sets the active routing mode.
   *
   * Validates that mode is exactly 'legacy' or 'new'.
   * Logs the previous value, new value, operator identity, and timestamp.
   * Resets the circuit breaker when mode is changed (operator acknowledgment).
   *
   * @param mode - The new routing mode ('legacy' or 'new')
   * @param operatorId - Identity of the operator making the change
   * @throws Error if mode is not exactly 'legacy' or 'new'
   */
  setMode(mode: FxMode, operatorId: string): void {
    if (mode !== 'legacy' && mode !== 'new') {
      throw new Error(
        `Invalid FX routing mode: "${mode}". Must be exactly "legacy" or "new".`,
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
