import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ProductionModeGuardService } from './production-mode-guard.service';

describe('ProductionModeGuardService (Mainnet-only)', () => {
  function createService(envVars: Record<string, string | undefined>) {
    return Test.createTestingModule({
      providers: [
        ProductionModeGuardService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => envVars[key]),
          },
        },
      ],
    }).compile();
  }

  describe('isProductionMode()', () => {
    it('always returns true on Mainnet', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(service.isProductionMode()).toBe(true);
    });
  });

  describe('validateFxModeForProduction()', () => {
    it('accepts "new" mode', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(() => service.validateFxModeForProduction('new')).not.toThrow();
    });

    it('rejects "legacy" mode', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(() => service.validateFxModeForProduction('legacy')).toThrow();
    });
  });

  describe('enforceProductionMode()', () => {
    it('passes when routing mode is not legacy and auto-update-rates is disabled', async () => {
      const module = await createService({
        FX_ROUTING_MODE: 'new',
        AUTO_UPDATE_RATES_ENABLED: 'false',
      });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).not.toThrow();
    });

    it('rejects legacy routing mode', async () => {
      const module = await createService({ FX_ROUTING_MODE: 'legacy' });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).toThrow();
    });

    it('rejects enabled auto-update-rates', async () => {
      const module = await createService({ AUTO_UPDATE_RATES_ENABLED: 'true' });
      const service = module.get(ProductionModeGuardService);

      expect(() => service.enforceProductionMode()).toThrow();
    });
  });

  describe('isAutoUpdateRatesDisabled()', () => {
    it('returns true by default on Mainnet', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(service.isAutoUpdateRatesDisabled()).toBe(true);
    });

    it('returns false only when explicitly enabled', async () => {
      const module = await createService({ AUTO_UPDATE_RATES_ENABLED: 'true' });
      const service = module.get(ProductionModeGuardService);

      expect(service.isAutoUpdateRatesDisabled()).toBe(false);
    });
  });

  describe('deprecated adapter pricing guards', () => {
    it('always rejects exchange-rate reads and writes', async () => {
      const module = await createService({});
      const service = module.get(ProductionModeGuardService);

      expect(() => service.guardGetExchangeRate()).toThrow();
      expect(() => service.guardSetExchangeRate()).toThrow();
    });
  });
});
