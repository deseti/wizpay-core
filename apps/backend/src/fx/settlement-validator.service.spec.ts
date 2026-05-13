import { SettlementValidator } from './settlement-validator.service';
import { DEVIATION_TOLERANCE_PERCENT } from './fx.constants';

describe('SettlementValidator', () => {
  let service: SettlementValidator;

  beforeEach(() => {
    service = new SettlementValidator();
  });

  describe('validateOutput() - accepted settlements', () => {
    it('accepts when settledAmount equals minAcceptableOutput', () => {
      const result = service.validateOutput({
        settledAmount: '100.00',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('accepts when settledAmount exceeds minAcceptableOutput', () => {
      const result = service.validateOutput({
        settledAmount: '105.50',
        minAcceptableOutput: '100.00',
        quotedAmount: '104.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('accepts when settledAmount is much larger than minAcceptableOutput', () => {
      const result = service.validateOutput({
        settledAmount: '500.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
    });
  });

  describe('validateOutput() - rejected settlements', () => {
    it('rejects when settledAmount is less than minAcceptableOutput', () => {
      const result = service.validateOutput({
        settledAmount: '99.50',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('99.5');
      expect(result.reason).toContain('100');
      expect(result.reason).toContain('less than minAcceptableOutput');
    });

    it('includes expected min, actual, and difference in rejection reason', () => {
      const result = service.validateOutput({
        settledAmount: '95.00',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('95');
      expect(result.reason).toContain('100');
      expect(result.reason).toContain('5');
    });
  });

  describe('validateOutput() - missing/zero settledAmount', () => {
    it('rejects when settledAmount is empty string', () => {
      const result = service.validateOutput({
        settledAmount: '',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('missing or not a valid number');
    });

    it('rejects when settledAmount is whitespace only', () => {
      const result = service.validateOutput({
        settledAmount: '   ',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('missing or not a valid number');
    });

    it('rejects when settledAmount is not a valid number', () => {
      const result = service.validateOutput({
        settledAmount: 'abc',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('missing or not a valid number');
    });

    it('rejects when settledAmount is zero', () => {
      const result = service.validateOutput({
        settledAmount: '0',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('zero');
    });

    it('rejects when settledAmount is "0.00"', () => {
      const result = service.validateOutput({
        settledAmount: '0.00',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('zero');
    });
  });

  describe('validateOutput() - deviation alert triggered', () => {
    it('sets alertRequired when deviation exceeds default tolerance (1%)', () => {
      // settled=102, quoted=100 → deviation = 2% > 1%
      const result = service.validateOutput({
        settledAmount: '102.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(true);
      expect(result.deviationPercent).toBeCloseTo(2.0, 4);
    });

    it('sets alertRequired when settled is below quoted by more than tolerance', () => {
      // settled=98, quoted=100 → deviation = 2% > 1%
      const result = service.validateOutput({
        settledAmount: '98.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(true);
      expect(result.deviationPercent).toBeCloseTo(2.0, 4);
    });

    it('still delivers funds (accepted=true) even when alert is triggered', () => {
      // Large deviation but still above minOutput
      const result = service.validateOutput({
        settledAmount: '110.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(true);
      expect(result.deviationPercent).toBeCloseTo(10.0, 4);
    });

    it('uses custom tolerancePercent when provided', () => {
      // settled=103, quoted=100 → deviation = 3%, tolerance = 5% → no alert
      const result = service.validateOutput({
        settledAmount: '103.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
        tolerancePercent: 5,
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(false);
      expect(result.deviationPercent).toBeCloseTo(3.0, 4);
    });
  });

  describe('validateOutput() - no alert when within tolerance', () => {
    it('does not alert when deviation is exactly 0%', () => {
      const result = service.validateOutput({
        settledAmount: '100.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(false);
      expect(result.deviationPercent).toBeCloseTo(0.0, 4);
    });

    it('does not alert when deviation is below tolerance', () => {
      // settled=100.50, quoted=100 → deviation = 0.5% < 1%
      const result = service.validateOutput({
        settledAmount: '100.50',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(false);
      expect(result.deviationPercent).toBeCloseTo(0.5, 4);
    });

    it('does not alert when deviation is exactly at tolerance boundary', () => {
      // settled=101, quoted=100 → deviation = 1% = tolerance → NOT alerting (> not >=)
      const result = service.validateOutput({
        settledAmount: '101.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(false);
      expect(result.deviationPercent).toBeCloseTo(1.0, 4);
    });
  });

  describe('validateOutput() - edge cases', () => {
    it('handles exact minimum output (settledAmount == minAcceptableOutput)', () => {
      const result = service.validateOutput({
        settledAmount: '99.99',
        minAcceptableOutput: '99.99',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(true);
    });

    it('handles very small amounts', () => {
      const result = service.validateOutput({
        settledAmount: '0.01',
        minAcceptableOutput: '0.01',
        quotedAmount: '0.01',
      });

      expect(result.accepted).toBe(true);
      expect(result.deviationPercent).toBeCloseTo(0.0, 4);
      expect(result.alertRequired).toBe(false);
    });

    it('handles very large amounts', () => {
      const result = service.validateOutput({
        settledAmount: '999999999.99',
        minAcceptableOutput: '999999000.00',
        quotedAmount: '999999999.99',
      });

      expect(result.accepted).toBe(true);
      expect(result.alertRequired).toBe(false);
    });

    it('handles negative settledAmount as less than minOutput', () => {
      const result = service.validateOutput({
        settledAmount: '-5.00',
        minAcceptableOutput: '100.00',
        quotedAmount: '100.00',
      });

      expect(result.accepted).toBe(false);
    });

    it('calculates deviation correctly with decimal precision', () => {
      // settled=85.5, quoted=85.0 → deviation = |0.5/85| * 100 ≈ 0.588%
      const result = service.validateOutput({
        settledAmount: '85.50',
        minAcceptableOutput: '84.00',
        quotedAmount: '85.00',
      });

      expect(result.accepted).toBe(true);
      expect(result.deviationPercent).toBeCloseTo(0.5882, 2);
      expect(result.alertRequired).toBe(false);
    });

    it('defaults tolerancePercent to DEVIATION_TOLERANCE_PERCENT when not provided', () => {
      // Verify the default tolerance is used (1%)
      // settled=101.5, quoted=100 → deviation = 1.5% > 1% default
      const result = service.validateOutput({
        settledAmount: '101.50',
        minAcceptableOutput: '95.00',
        quotedAmount: '100.00',
      });

      expect(result.alertRequired).toBe(true);
      expect(DEVIATION_TOLERANCE_PERCENT).toBe(1);
    });

    it('handles quotedAmount of zero gracefully (no deviation calculation)', () => {
      const result = service.validateOutput({
        settledAmount: '100.00',
        minAcceptableOutput: '95.00',
        quotedAmount: '0',
      });

      expect(result.accepted).toBe(true);
      expect(result.deviationPercent).toBeUndefined();
      expect(result.alertRequired).toBe(false);
    });

    it('handles invalid quotedAmount gracefully (no deviation calculation)', () => {
      const result = service.validateOutput({
        settledAmount: '100.00',
        minAcceptableOutput: '95.00',
        quotedAmount: 'invalid',
      });

      expect(result.accepted).toBe(true);
      expect(result.deviationPercent).toBeUndefined();
      expect(result.alertRequired).toBe(false);
    });
  });
});
