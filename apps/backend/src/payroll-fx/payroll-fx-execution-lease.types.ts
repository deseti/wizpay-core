export interface PayrollFxExecutionLease {
  operationId: string;
  leaseId: string;
  expiresAt: Date;
  attemptCount: number;
}

export interface PayrollFxClock {
  now(): Date;
}

export const SYSTEM_PAYROLL_FX_CLOCK: PayrollFxClock = {
  now: () => new Date(),
};
