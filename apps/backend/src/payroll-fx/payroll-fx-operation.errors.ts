export class PayrollFxOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollFxOperationValidationError';
  }
}

export class PayrollFxOperationIntentConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(
      `Payroll FX idempotency key "${idempotencyKey}" already exists with conflicting immutable intent.`,
    );
    this.name = 'PayrollFxOperationIntentConflictError';
  }
}

export class PayrollFxOperationStateConflictError extends Error {
  constructor(operationId: string, expectedStatus: string) {
    super(
      `Payroll FX operation "${operationId}" is not in expected state "${expectedStatus}".`,
    );
    this.name = 'PayrollFxOperationStateConflictError';
  }
}

export class PayrollFxOperationTaskConflictError extends Error {
  constructor(operationId: string) {
    super(
      `Payroll FX operation "${operationId}" is already attached to a different Payroll task.`,
    );
    this.name = 'PayrollFxOperationTaskConflictError';
  }
}

export class PayrollFxOperationNotFoundError extends Error {
  constructor(operationId: string) {
    super(`Payroll FX operation "${operationId}" was not found.`);
    this.name = 'PayrollFxOperationNotFoundError';
  }
}
