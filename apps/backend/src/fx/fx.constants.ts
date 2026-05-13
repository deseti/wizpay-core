/**
 * Default configuration constants for the StableFX RFQ settlement flow.
 *
 * These values are used as defaults when environment-specific configuration
 * is not provided. All can be overridden via environment variables.
 */

/** Polling interval for settlement status checks (milliseconds). */
export const FX_POLL_INTERVAL_MS = 3000;

/** Maximum number of poll attempts before marking a settlement as timed out. */
export const FX_POLL_MAX_ATTEMPTS = 60;

/** Number of failures in the rolling window that triggers the circuit breaker. */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/** Size of the rolling window for circuit breaker evaluation. */
export const CIRCUIT_BREAKER_WINDOW = 20;

/** Tolerance percentage for settlement deviation alerts (default 1%). */
export const DEVIATION_TOLERANCE_PERCENT = 1;

/** Rate anomaly threshold: log warning if consecutive quotes deviate by more than this percentage. */
export const RATE_ANOMALY_THRESHOLD_PERCENT = 5;
