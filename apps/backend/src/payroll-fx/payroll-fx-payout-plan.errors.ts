export class PayrollFxPayoutPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollFxPayoutPlanValidationError';
  }
}

export class PayrollFxPayoutPlanConflictError extends Error {
  constructor(operationId: string) {
    super(
      `Payroll FX operation ${operationId} already has a different immutable payout plan.`,
    );
    this.name = 'PayrollFxPayoutPlanConflictError';
  }
}

export class PayrollFxTaskBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollFxTaskBindingConflictError';
  }
}
