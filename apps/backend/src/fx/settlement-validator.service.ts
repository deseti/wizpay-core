import { Injectable, Logger } from '@nestjs/common';
import { DEVIATION_TOLERANCE_PERCENT } from './fx.constants';
import { ValidationResult } from './fx.types';

/**
 * Parameters for settlement output validation.
 */
export interface ValidateOutputParams {
  /** The actual amount settled by FxEscrow (decimal string). */
  settledAmount: string;
  /** The minimum acceptable output specified in the original payment request (decimal string). */
  minAcceptableOutput: string;
  /** The quoted amount from the RFQ quote (decimal string). */
  quotedAmount: string;
  /** Tolerance percentage for deviation alerts (default: DEVIATION_TOLERANCE_PERCENT). */
  tolerancePercent?: number;
}

/**
 * SettlementValidator is the NestJS injectable service responsible for
 * validating settlement output against minimum acceptable thresholds
 * and detecting deviations from quoted amounts.
 *
 * Responsibilities:
 * - Compare settled amount against minimum acceptable output
 * - Reject settlements where settled amount is missing, zero, or invalid
 * - Reject settlements where settled amount < minimum acceptable output
 * - Calculate deviation percentage between settled and quoted amounts
 * - Flag alerts when deviation exceeds configured tolerance (default 1%)
 * - Even when alert is triggered, funds are still delivered if minimum output is met
 *
 * Requirements: 10.1, 10.2, 10.5, 10.6
 */
@Injectable()
export class SettlementValidator {
  private readonly logger = new Logger(SettlementValidator.name);

  /**
   * Validates the settlement output against the minimum acceptable output
   * and calculates deviation from the quoted amount.
   *
   * @param params - Validation parameters including settled, minimum, and quoted amounts
   * @returns ValidationResult indicating acceptance, deviation, and alert status
   */
  validateOutput(params: ValidateOutputParams): ValidationResult {
    const {
      settledAmount,
      minAcceptableOutput,
      quotedAmount,
      tolerancePercent = DEVIATION_TOLERANCE_PERCENT,
    } = params;

    // Parse settledAmount — reject if missing, empty, or not a valid number
    const settled = parseFloat(settledAmount);
    if (!settledAmount || settledAmount.trim() === '' || isNaN(settled)) {
      this.logger.warn(
        `[settlement-validation] Rejected: settledAmount is missing or invalid. ` +
          `settledAmount="${settledAmount}"`,
      );
      return {
        accepted: false,
        reason: `Settlement rejected: settledAmount is missing or not a valid number (got "${settledAmount}")`,
      };
    }

    // Reject if settledAmount is zero
    if (settled === 0) {
      this.logger.warn(
        `[settlement-validation] Rejected: settledAmount is zero.`,
      );
      return {
        accepted: false,
        reason: `Settlement rejected: settledAmount is zero`,
      };
    }

    // Parse minAcceptableOutput
    const minOutput = parseFloat(minAcceptableOutput);

    // Compare settledAmount against minAcceptableOutput
    if (settled < minOutput) {
      const difference = minOutput - settled;
      this.logger.warn(
        `[settlement-validation] Rejected: settledAmount (${settled}) < minAcceptableOutput (${minOutput}). ` +
          `Difference: ${difference}`,
      );
      return {
        accepted: false,
        reason:
          `Settlement rejected: settledAmount (${settled}) is less than minAcceptableOutput (${minOutput}). ` +
          `Difference: ${difference}`,
      };
    }

    // Calculate deviation from quoted amount
    const quoted = parseFloat(quotedAmount);
    let deviationPercent: number | undefined;
    let alertRequired = false;

    if (!isNaN(quoted) && quoted !== 0) {
      deviationPercent =
        Math.abs((settled - quoted) / quoted) * 100;

      // Set alertRequired if deviation exceeds tolerance
      if (deviationPercent > tolerancePercent) {
        alertRequired = true;
        this.logger.warn(
          `[settlement-validation] Alert: deviation ${deviationPercent.toFixed(4)}% exceeds ` +
            `tolerance ${tolerancePercent}%. settled=${settled}, quoted=${quoted}`,
        );
      }
    }

    return {
      accepted: true,
      deviationPercent,
      alertRequired,
    };
  }
}
