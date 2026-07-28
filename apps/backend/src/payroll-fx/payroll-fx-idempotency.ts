import { createHash } from 'crypto';

const PAYROLL_FX_OPERATION_KEY_PREFIX = 'payroll-fx:app:stablefx';

export function buildPayrollFxOperationIdempotencyKey(
  referenceId: string,
): string {
  const normalizedReference = referenceId.trim();
  const digest = createHash('sha256')
    .update(`${PAYROLL_FX_OPERATION_KEY_PREFIX}:${normalizedReference}`)
    .digest('hex');

  return `${PAYROLL_FX_OPERATION_KEY_PREFIX}:${digest}`;
}
