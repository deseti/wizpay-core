import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FxRoutingGuard } from './fx-routing-guard.service';
import { CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_WINDOW } from './fx.constants';

describe('FxRoutingGuard', () => {
  let service: FxRoutingGuard;
  let configService: ConfigService;

  function createService(fxRoutingMode?: string) {
    const module = Test.createTestingModule({
      providers: [
        FxRoutingGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'FX_ROUTING_MODE') return fxRoutingMode;
              return undefined;
            }),
          },
        },
      ],
    });

    return module.compile();
  }

  describe('getActiveMode()', () => {
    it('returns "legacy" when config is set to "legacy"', async () => {
      const module = await createService('legacy');
      service = module.get(FxRoutingGuard);

      expect(service.getActiveMode()).toBe('legacy');
    });

    it('returns "new" when config is set to "new"', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);

      expect(service.getActiveMode()).toBe('new');
    });

    it('throws when config is unset (undefined)', async () => {
      const module = await createService(undefined);
      service = module.get(FxRoutingGuard);

      expect(() => service.getActiveMode()).toThrow(
        /FX routing configuration is unavailable/,
      );
    });

    it('throws when config contains an invalid value', async () => {
      const module = await createService('invalid');
      service = module.get(FxRoutingGuard);

      expect(() => service.getActiveMode()).toThrow(
        /FX routing configuration is unavailable/,
      );
    });

    it('throws when config is empty string', async () => {
      const module = await createService('');
      service = module.get(FxRoutingGuard);

      expect(() => service.getActiveMode()).toThrow(
        /FX routing configuration is unavailable/,
      );
    });

    it('caches the mode after first successful read', async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);
      configService = module.get(ConfigService);

      service.getActiveMode();
      service.getActiveMode();

      // ConfigService.get should only be called once (cached after first read)
      expect(configService.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('setMode()', () => {
    beforeEach(async () => {
      const module = await createService('legacy');
      service = module.get(FxRoutingGuard);
    });

    it('changes the active mode to "new"', () => {
      service.getActiveMode(); // initialize
      service.setMode('new', 'operator-1');

      expect(service.getActiveMode()).toBe('new');
    });

    it('changes the active mode to "legacy"', () => {
      service.getActiveMode(); // initialize
      service.setMode('new', 'operator-1');
      service.setMode('legacy', 'operator-2');

      expect(service.getActiveMode()).toBe('legacy');
    });

    it('throws for invalid mode values', () => {
      expect(() => service.setMode('invalid' as any, 'operator-1')).toThrow(
        /Invalid FX routing mode/,
      );
    });

    it('resets the circuit breaker when mode is changed', () => {
      service.getActiveMode(); // initialize
      service.setMode('new', 'operator-1');

      // Trigger circuit breaker
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        service.recordOutcome('new', false);
      }
      expect(service.isCircuitOpen()).toBe(true);

      // Operator changes mode — resets circuit
      service.setMode('new', 'operator-2');
      expect(service.isCircuitOpen()).toBe(false);
    });
  });

  describe('recordOutcome()', () => {
    beforeEach(async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);
    });

    it('appends outcomes to the rolling window', () => {
      service.recordOutcome('new', true);
      service.recordOutcome('new', false);

      expect(service.getOutcomes()).toHaveLength(2);
    });

    it('caps the rolling window at CIRCUIT_BREAKER_WINDOW entries', () => {
      for (let i = 0; i < CIRCUIT_BREAKER_WINDOW + 5; i++) {
        service.recordOutcome('new', true);
      }

      expect(service.getOutcomes()).toHaveLength(CIRCUIT_BREAKER_WINDOW);
    });

    it('records timestamp, success, and operationId for each entry', () => {
      service.recordOutcome('new', true);

      const outcomes = service.getOutcomes();
      expect(outcomes[0]).toHaveProperty('timestamp');
      expect(outcomes[0]).toHaveProperty('success', true);
      expect(outcomes[0]).toHaveProperty('operationId');
      expect(outcomes[0].operationId).toMatch(/^op_/);
    });
  });

  describe('isCircuitOpen()', () => {
    beforeEach(async () => {
      const module = await createService('new');
      service = module.get(FxRoutingGuard);
    });

    it('returns false when no outcomes recorded', () => {
      expect(service.isCircuitOpen()).toBe(false);
    });

    it('returns false when failures are below threshold', () => {
      service.recordOutcome('new', false);
      service.recordOutcome('new', false);
      service.recordOutcome('new', true);

      expect(service.isCircuitOpen()).toBe(false);
    });

    it('returns true when failures reach threshold', () => {
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        service.recordOutcome('new', false);
      }

      expect(service.isCircuitOpen()).toBe(true);
    });

    it('returns true when failures exceed threshold', () => {
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD + 2; i++) {
        service.recordOutcome('new', false);
      }

      expect(service.isCircuitOpen()).toBe(true);
    });

    it('does not open circuit for legacy mode failures', () => {
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD + 5; i++) {
        service.recordOutcome('legacy', false);
      }

      expect(service.isCircuitOpen()).toBe(false);
    });

    it('opens circuit when failures accumulate across mixed outcomes', () => {
      // Mix of successes and failures, but enough failures to trigger
      service.recordOutcome('new', true);
      service.recordOutcome('new', false);
      service.recordOutcome('new', true);
      service.recordOutcome('new', false);
      service.recordOutcome('new', false);

      expect(service.isCircuitOpen()).toBe(true);
    });

    it('stays open until operator resets via setMode', () => {
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        service.recordOutcome('new', false);
      }
      expect(service.isCircuitOpen()).toBe(true);

      // Recording more successes does not close the circuit
      for (let i = 0; i < 10; i++) {
        service.recordOutcome('new', true);
      }
      expect(service.isCircuitOpen()).toBe(true);

      // Only operator action resets it
      service.setMode('new', 'operator-reset');
      expect(service.isCircuitOpen()).toBe(false);
    });

    it('can re-open after being reset if failures recur', () => {
      // Open circuit
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        service.recordOutcome('new', false);
      }
      expect(service.isCircuitOpen()).toBe(true);

      // Reset
      service.setMode('new', 'operator-1');
      expect(service.isCircuitOpen()).toBe(false);

      // Trigger again
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        service.recordOutcome('new', false);
      }
      expect(service.isCircuitOpen()).toBe(true);
    });
  });
});
