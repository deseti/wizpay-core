import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PayrollFxOperation } from './payroll-fx-operation.types';

const DEFAULT_LEASE_MS = 300_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 900_000;

@Injectable()
export class PayrollFxRecoveryPolicy {
  readonly maxPreSideEffectAttempts = 3;

  constructor(private readonly config: ConfigService) {}

  leaseDurationMs(): number {
    const configured = Number(
      this.config.get<string>('PAYROLL_FX_EXECUTION_LEASE_MS'),
    );
    if (!Number.isSafeInteger(configured)) return DEFAULT_LEASE_MS;
    return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, configured));
  }

  isTransientPreSideEffect(operation: PayrollFxOperation): boolean {
    const snapshot = operation.diagnosticSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return false;
    }
    const status = snapshot.httpStatus;
    return (
      typeof status === 'number' &&
      (status === 408 || status === 429 || status >= 500)
    );
  }
}
