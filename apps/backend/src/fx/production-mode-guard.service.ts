import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * ProductionModeGuardService enforces Mainnet-only execution constraints.
 *
 * Arc Mainnet is the only supported network:
 * - fxMode MUST be "new" (provider-priced execution)
 * - Backend "legacy" execution paths are retired and rejected
 * - The auto-update-rates scheduled job is disabled
 * - Reads and writes against the deprecated adapter pricing are rejected
 */
@Injectable()
export class ProductionModeGuardService {
  private readonly logger = new Logger(ProductionModeGuardService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns true: the backend always runs in Mainnet production mode.
   */
  isProductionMode(): boolean {
    return true;
  }

  /**
   * Validates that the fxMode is not "legacy".
   *
   * The system MUST use "new" mode exclusively. Any attempt to use "legacy"
   * mode is rejected with an explicit error.
   *
   * @param fxMode - The current FX routing mode
   * @throws Error if fxMode is "legacy"
   */
  validateFxModeForProduction(fxMode: string): void {
    if (fxMode === 'legacy') {
      throw new Error(
        'Production mode violation: fxMode="legacy" is not permitted on Arc Mainnet. ' +
          'All FX operations must route through the Mainnet provider flow.',
      );
    }
  }

  /**
   * Enforces all production mode constraints.
   *
   * Checks:
   * 1. fxMode must not be "legacy"
   * 2. auto-update-rates must be disabled
   *
   * Call this at application startup or before FX operations to ensure
   * the system is correctly configured.
   *
   * @throws Error if any production mode constraint is violated
   */
  enforceProductionMode(): void {
    this.logger.log(
      '[production-mode-guard] Mainnet production mode active. ' +
        'Enforcing provider-only constraints.',
    );

    // Validate that FX_ROUTING_MODE is not set to legacy
    const fxRoutingMode = this.configService.get<string>('FX_ROUTING_MODE');
    if (fxRoutingMode === 'legacy') {
      throw new Error(
        'Production mode misconfiguration: FX_ROUTING_MODE="legacy" is not permitted ' +
          'on Arc Mainnet. Set FX_ROUTING_MODE="new".',
      );
    }

    // Validate auto-update-rates is disabled
    if (!this.isAutoUpdateRatesDisabled()) {
      throw new Error(
        'Production mode misconfiguration: auto-update-rates must be disabled ' +
          'on Arc Mainnet. Set AUTO_UPDATE_RATES_ENABLED=false.',
      );
    }
  }

  /**
   * Returns true when the auto-update-rates scheduled job should be disabled.
   *
   * On Mainnet the auto-update-rates job that writes internal exchange rates
   * MUST be disabled. No automated process should update internal rates.
   *
   * The job is disabled when:
   * - AUTO_UPDATE_RATES_ENABLED is explicitly set to "false", or
   * - AUTO_UPDATE_RATES_ENABLED is unset (disabled by default on Mainnet)
   */
  isAutoUpdateRatesDisabled(): boolean {
    const autoUpdateEnabled = this.configService.get<string>(
      'AUTO_UPDATE_RATES_ENABLED',
    );
    return autoUpdateEnabled !== 'true';
  }

  /**
   * Guards against getExchangeRate calls on the deprecated adapter
   * on Mainnet.
   *
   * Any attempt to read exchange rates from the deprecated
   * contract is rejected. The system must use Mainnet provider pricing.
   *
   * @throws Error always
   */
  guardGetExchangeRate(): void {
    throw new Error(
      'Production mode rejection: getExchangeRate on the deprecated adapter is ' +
        'decommissioned. All FX pricing must come from the Mainnet provider flow. ' +
        'The internal pricing source has been decommissioned and no cached ' +
        'or default rate is available.',
    );
  }

  /**
   * Guards against setExchangeRate calls on the deprecated adapter
   * on Mainnet.
   *
   * No automated or manual process should update internal exchange rates.
   *
   * @throws Error always
   */
  guardSetExchangeRate(): void {
    throw new Error(
      'Production mode rejection: setExchangeRate on the deprecated adapter is ' +
        'disabled. The auto-update-rates job must not run. ' +
        'All FX pricing comes exclusively from the Mainnet provider flow.',
    );
  }
}
