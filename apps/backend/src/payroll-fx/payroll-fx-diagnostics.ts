import { HttpException } from '@nestjs/common';
import type { PayrollFxDiagnosticValue } from './payroll-fx-operation.types';

const MAX_FAILURE_TEXT_LENGTH = 300;
const SAFE_FAILURE_CODE = /^[A-Z0-9_:-]{1,100}$/;

export interface PayrollFxSafeFailure {
  failureCode: string;
  failureMessage: string;
  diagnosticSnapshot: PayrollFxDiagnosticValue;
}

export function buildPayrollFxSafeFailure(
  error: unknown,
  stage: string,
): PayrollFxSafeFailure {
  const errorRecord = toRecord(error);
  const response = toRecord(errorRecord?.response);
  const rawCode =
    readString(response?.code) ??
    readString(errorRecord?.code) ??
    'PAYROLL_FX_LIFECYCLE_FAILED';
  const failureCode = SAFE_FAILURE_CODE.test(rawCode)
    ? rawCode
    : 'PAYROLL_FX_LIFECYCLE_FAILED';
  const failureMessage = (
    error instanceof HttpException
      ? readFailureMessage(error, response)
      : 'External Payroll FX lifecycle call failed.'
  ).slice(0, MAX_FAILURE_TEXT_LENGTH);
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : (readNumber(errorRecord?.status) ??
        readNumber(errorRecord?.statusCode) ??
        readNumber(response?.statusCode));

  return {
    failureCode,
    failureMessage,
    diagnosticSnapshot: {
      stage: normalizeStage(stage),
      errorType:
        error instanceof Error
          ? error.constructor.name.slice(0, 100)
          : typeof error,
      ...(status === undefined ? {} : { httpStatus: status }),
      providerCode: failureCode,
    },
  };
}

function readFailureMessage(
  error: unknown,
  response: Record<string, unknown> | null,
): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return (
    readString(response?.message) ??
    readString(toRecord(error)?.message) ??
    'Payroll FX lifecycle failed.'
  );
}

function normalizeStage(stage: string): string {
  const normalized = stage
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  return normalized.slice(0, 100) || 'unknown';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
