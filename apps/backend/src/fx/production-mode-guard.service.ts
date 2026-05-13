import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * ProductionModeGuardService enforces production mode constraints
 * for the StableFX migration.
 *
 * In production mode (NEXT_PUBLIC_USE_REAL_STABLEFX=true):
 * - fxMode MUST be "stablefx" (mapped to "new" internally)
 * - Runtime fallback to "legacy" mode is rejected
 * - The auto-update-rates scheduled job is disabled
 * - getExchangeRate on the deprecated StableFXAdapter_V2 is rejected
 *
 * In test/development mode:
 * - fxMode="legacy" is permitted
 * - StableFXAdapter_V2 and setExchangeRate remain functional
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7
 */
@Injectable()
export class ProductionModeGuardService {
  private readonly logger = new Logger(ProductionModeGuardService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns true when the system is deployed in production mode.
   * Production mode is indicated by NEXT_PUBLIC_USE_REAL_STABLEFX=true.
   */
  isProductionMode(): boolean {
    const value = this.configService.get<string>(
      'NEXT_PUBLIC_USE_REAL_STABLEFX',
    );
    return value === 'true';
  }

  /**
   * Validates that the fxMode is not "legacy" in production mode.
   *
   * In production (NEXT_PUBLIC_USE_REAL_STABLEFX=true), the system MUST
   * use "stablefx" (or "new") mode exclusively. Any attempt to use "legacy"
   * mode is rejected with an explicit error.
   *
   * @param fxMode - The current FX routing mode
   * @throws Error if fxMode is "legacy" while in production mode
   */
  validateFxModeForProduction(fxMode: string): void {
    if (this.isProductionMode() && fxMode === 'legacy') {
      throw new Error(
        'Production mode violation: fxMode="legacy" is not permitted when ' +
          'NEXT_PUBLIC_USE_REAL_STABLEFX=true. All FX operations must route ' +
          'through Circle StableFX RFQ. Remove legacy fallback or set ' +
          'NEXT_PUBLIC_USE_REAL_STABLEFX=false for test environments.',
      );
    }
  }

  /**
   * Enforces all production mode constraints.
   *
   * Checks:
   * 1. If in production mode, fxMode must not be "legacy"
   * 2. If in production mode, auto-update-rates must be disabled
   * 3. If in production mode, getExchangeRate calls are rejected
   *
   * Call this at application startup or before FX operations to ensure
   * the system is correctly configured.
   *
   * @throws Error if any production mode constraint is violated
   */
  enforceProductionMode(): void {
    if (!this.isProductionMode()) {
      this.logger.log(
        '[production-mode-guard] Not in production mode — legacy operations permitted.',
      );
      return;
    }

    this.logger.log(
      '[production-mode-guard] Production mode active (NEXT_PUBLIC_USE_REAL_STABLEFX=true). ' +
        'Enforcing StableFX-only constraints.',
    );

    // Validate that FX_ROUTING_MODE is not set to legacy
    const fxRoutingMode = this.configService.get<string>('FX_ROUTING_MODE');
    if (fxRoutingMode === 'legacy') {
      throw new Error(
        'Production mode misconfiguration: FX_ROUTING_MODE="legacy" is not permitted ' +
          'when NEXT_PUBLIC_USE_REAL_STABLEFX=true. Set FX_ROUTING_MODE="new" for production.',
      );
    }

    // Validate auto-update-rates is disabled
    if (!this.isAutoUpdateRatesDisabled()) {
      throw new Error(
        'Production mode misconfiguration: auto-update-rates must be disabled ' +
          'when NEXT_PUBLIC_USE_REAL_STABLEFX=true. Set AUTO_UPDATE_RATES_ENABLED=false.',
      );
    }
  }

  /**
   * Returns true when the auto-update-rates scheduled job should be disabled.
   *
   * In production mode, the auto-update-rates job that calls setExchangeRate
   * on StableFXAdapter_V2 MUST be disabled. No automated process should
   * update internal exchange rates in production.
   *
   * The job is disabled when:
   * - NEXT_PUBLIC_USE_REAL_STABLEFX=true (production mode), OR
   * - AUTO_UPDATE_RATES_ENABLED is explicitly set to "false"
   */
  isAutoUpdateRatesDisabled(): boolean {
    // In production mode, auto-update-rates is always disabled
    if (this.isProductionMode()) {
      return true;
    }

    // Also respect explicit configuration
    const autoUpdateEnabled = this.configService.get<string>(
      'AUTO_UPDATE_RATES_ENABLED',
    );
    return autoUpdateEnabled === 'false';
  }

  /**
   * Guards against getExchangeRate calls on the deprecated StableFXAdapter_V2
   * in production mode.
   *
   * In production mode, any attempt to read exchange rates from the deprecated
   * contract is rejected. The system must use Circle StableFX RFQ exclusively.
   *
   * @throws Error if called in production mode
   */
  guardGetExchangeRate(): void {
    if (this.isProductionMode()) {
      throw new Error(
        'Production mode rejection: getExchangeRate on StableFXAdapter_V2 is ' +
          'decommissioned. All FX pricing must come from Circle StableFX RFQ. ' +
          'The internal pricing source has been decommissioned and no cached ' +
          'or default rate is available.',
      );
    }
  }

  /**
   * Guards against setExchangeRate calls on the deprecated StableFXAdapter_V2
   * in production mode.
   *
   * In production mode, no automated or manual process should update
   * internal exchange rates.
   *
   * @throws Error if called in production mode
   */
  guardSetExchangeRate(): void {
    if (this.isProductionMode()) {
      throw new Error(
        'Production mode rejection: setExchangeRate on StableFXAdapter_V2 is ' +
          'disabled in production. The auto-update-rates job must not run. ' +
          'All FX pricing comes exclusively from Circle StableFX RFQ.',
      );
    }
  }
}
