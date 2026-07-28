import {
  PayrollFxExecutionProvider as PrismaExecutionProvider,
  PayrollFxOperation as PrismaPayrollFxOperation,
  PayrollFxOperationStatus as PrismaOperationStatus,
  PayrollFxWalletMode as PrismaWalletMode,
  Prisma,
} from '@prisma/client';
import {
  PayrollFxExecutionProvider,
  PayrollFxDiagnosticValue,
  PayrollFxOperation,
  PayrollFxOperationIntent,
  PayrollFxOperationStatus,
} from './payroll-fx-operation.types';
import { PayrollFxOperationValidationError } from './payroll-fx-operation.errors';

const MAX_DIAGNOSTIC_SNAPSHOT_BYTES = 16_384;
const FORBIDDEN_DIAGNOSTIC_KEY =
  /(?:authorization|api[_-]?key|secret|signature|typed[_-]?data|permit2|calldata|private[_-]?key)/i;

const STATUS_TO_PRISMA: Record<
  PayrollFxOperationStatus,
  PrismaOperationStatus
> = {
  created: PrismaOperationStatus.CREATED,
  quote_pending: PrismaOperationStatus.QUOTE_PENDING,
  quote_ready: PrismaOperationStatus.QUOTE_READY,
  approval_pending: PrismaOperationStatus.APPROVAL_PENDING,
  submitted: PrismaOperationStatus.SUBMITTED,
  funding_pending: PrismaOperationStatus.FUNDING_PENDING,
  settlement_pending: PrismaOperationStatus.SETTLEMENT_PENDING,
  settled: PrismaOperationStatus.SETTLED,
  payout_pending: PrismaOperationStatus.PAYOUT_PENDING,
  completed: PrismaOperationStatus.COMPLETED,
  recovery_required: PrismaOperationStatus.RECOVERY_REQUIRED,
  failed: PrismaOperationStatus.FAILED,
};

export function toPrismaPayrollFxStatus(
  status: PayrollFxOperationStatus,
): PrismaOperationStatus {
  return STATUS_TO_PRISMA[status];
}

export function toPrismaPayrollFxIntent(
  operationId: string,
  intent: PayrollFxOperationIntent,
): Prisma.PayrollFxOperationCreateInput {
  const normalized = normalizePayrollFxIntent(intent);

  return {
    operationId,
    idempotencyKey: normalized.idempotencyKey,
    walletMode: PrismaWalletMode.APP,
    executionProvider:
      normalized.executionProvider === 'stablefx'
        ? PrismaExecutionProvider.STABLEFX
        : PrismaExecutionProvider.SWAPKIT,
    sourceTokenAddress: normalized.sourceTokenAddress,
    destinationTokenAddress: normalized.destinationTokenAddress,
    sourceTokenSymbol: normalized.sourceTokenSymbol,
    destinationTokenSymbol: normalized.destinationTokenSymbol,
    network: normalized.network,
    sourceWalletAddress: normalized.sourceWalletAddress,
    treasuryWalletAddress: normalized.treasuryWalletAddress,
    amountInBaseUnits: normalized.amountInBaseUnits,
    requestedMinimumOutputBaseUnits: normalized.requestedMinimumOutputBaseUnits,
  };
}

export function mapPayrollFxOperation(
  record: PrismaPayrollFxOperation,
): PayrollFxOperation {
  return {
    operationId: record.operationId,
    idempotencyKey: record.idempotencyKey,
    taskId: record.taskId,
    walletMode: 'app',
    executionProvider:
      record.executionProvider.toLowerCase() as PayrollFxExecutionProvider,
    sourceTokenAddress: record.sourceTokenAddress,
    destinationTokenAddress: record.destinationTokenAddress,
    sourceTokenSymbol: record.sourceTokenSymbol,
    destinationTokenSymbol: record.destinationTokenSymbol,
    network: record.network,
    sourceWalletAddress: record.sourceWalletAddress,
    treasuryWalletAddress: record.treasuryWalletAddress,
    amountInBaseUnits: record.amountInBaseUnits,
    requestedMinimumOutputBaseUnits: record.requestedMinimumOutputBaseUnits,
    status: record.status.toLowerCase() as PayrollFxOperationStatus,
    failureCode: record.failureCode,
    failureMessage: record.failureMessage,
    quoteId: record.quoteId,
    quoteExpiresAt: record.quoteExpiresAt,
    expectedOutputBaseUnits: record.expectedOutputBaseUnits,
    actualOutputBaseUnits: record.actualOutputBaseUnits,
    providerOperationId: record.providerOperationId,
    approvalTransactionId: record.approvalTransactionId,
    approvalTransactionHash: record.approvalTransactionHash,
    fundingTransactionId: record.fundingTransactionId,
    fundingTransactionHash: record.fundingTransactionHash,
    settlementTransactionId: record.settlementTransactionId,
    settlementTransactionHash: record.settlementTransactionHash,
    payoutTransactionId: record.payoutTransactionId,
    payoutTransactionHash: record.payoutTransactionHash,
    approvalTargetAddress: record.approvalTargetAddress,
    lastProviderStatus: record.lastProviderStatus,
    diagnosticSnapshot: mapDiagnosticValue(record.diagnosticSnapshot),
    executionLeaseId: record.executionLeaseId,
    executionLeaseExpiresAt: record.executionLeaseExpiresAt,
    executionAttemptCount: record.executionAttemptCount,
    lastAttemptStartedAt: record.lastAttemptStartedAt,
    lastAttemptFinishedAt: record.lastAttemptFinishedAt,
    recoveryFromStatus:
      record.recoveryFromStatus?.toLowerCase() as PayrollFxOperationStatus | null,
    submittedAt: record.submittedAt,
    fundingConfirmedAt: record.fundingConfirmedAt,
    settledAt: record.settledAt,
    payoutConfirmedAt: record.payoutConfirmedAt,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapDiagnosticValue(
  value: Prisma.JsonValue | undefined,
): PayrollFxDiagnosticValue {
  if (value === undefined) {
    return null;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(mapDiagnosticValue);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      mapDiagnosticValue(nestedValue),
    ]),
  );
}

export function normalizePayrollFxIntent(
  intent: PayrollFxOperationIntent,
): PayrollFxOperationIntent {
  if (intent.walletMode !== 'app') {
    throw new PayrollFxOperationValidationError(
      'Payroll FX walletMode must be "app".',
    );
  }
  if (!['stablefx', 'swapkit'].includes(intent.executionProvider)) {
    throw new PayrollFxOperationValidationError(
      'Payroll FX executionProvider must be stablefx or swapkit.',
    );
  }

  const normalized: PayrollFxOperationIntent = {
    ...intent,
    idempotencyKey: requireText(intent.idempotencyKey, 'idempotencyKey'),
    sourceTokenAddress: requireText(
      intent.sourceTokenAddress,
      'sourceTokenAddress',
    ).toLowerCase(),
    destinationTokenAddress: requireText(
      intent.destinationTokenAddress,
      'destinationTokenAddress',
    ).toLowerCase(),
    sourceTokenSymbol: requireText(
      intent.sourceTokenSymbol,
      'sourceTokenSymbol',
    ).toUpperCase(),
    destinationTokenSymbol: requireText(
      intent.destinationTokenSymbol,
      'destinationTokenSymbol',
    ).toUpperCase(),
    network: requireText(intent.network, 'network').toUpperCase(),
    sourceWalletAddress: requireText(
      intent.sourceWalletAddress,
      'sourceWalletAddress',
    ).toLowerCase(),
    treasuryWalletAddress: requireText(
      intent.treasuryWalletAddress,
      'treasuryWalletAddress',
    ).toLowerCase(),
    amountInBaseUnits: requireBaseUnits(
      intent.amountInBaseUnits,
      'amountInBaseUnits',
      false,
    ),
    requestedMinimumOutputBaseUnits:
      intent.requestedMinimumOutputBaseUnits == null
        ? null
        : requireBaseUnits(
            intent.requestedMinimumOutputBaseUnits,
            'requestedMinimumOutputBaseUnits',
            true,
          ),
  };

  if (
    normalized.sourceTokenAddress === normalized.destinationTokenAddress ||
    normalized.sourceTokenSymbol === normalized.destinationTokenSymbol
  ) {
    throw new PayrollFxOperationValidationError(
      'Payroll FX source and destination tokens must differ.',
    );
  }

  return normalized;
}

export function toBoundedDiagnosticJson(
  value: PayrollFxDiagnosticValue | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;

  assertSafeDiagnosticValue(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DIAGNOSTIC_SNAPSHOT_BYTES) {
    throw new PayrollFxOperationValidationError(
      'Payroll FX diagnostic snapshot exceeds 16384 bytes.',
    );
  }
  return value;
}

export function requireNonNegativeBaseUnits(
  value: string,
  field: string,
): string {
  return requireBaseUnits(value, field, true);
}

function requireBaseUnits(
  value: string,
  field: string,
  allowZero: boolean,
): string {
  if (!/^[0-9]+$/.test(value)) {
    throw new PayrollFxOperationValidationError(
      `${field} must be an integer base-unit string.`,
    );
  }
  if (!allowZero && BigInt(value) <= 0n) {
    throw new PayrollFxOperationValidationError(
      `${field} must be greater than zero.`,
    );
  }
  return value;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new PayrollFxOperationValidationError(`${field} is required.`);
  }
  return normalized;
}

function assertSafeDiagnosticValue(value: unknown, path = 'snapshot'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeDiagnosticValue(item, `${path}[${index}]`),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_DIAGNOSTIC_KEY.test(key)) {
        throw new PayrollFxOperationValidationError(
          `Payroll FX diagnostic snapshot contains forbidden field ${path}.${key}.`,
        );
      }
      assertSafeDiagnosticValue(nested, `${path}.${key}`);
    }
  }
}
