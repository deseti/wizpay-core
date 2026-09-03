export const ACTIVITY_TYPES = [
  'send',
  'receive',
  'payroll',
  'swap',
  'bridge',
  'fx',
  'invoice_payment',
] as const;
export const ACTIVITY_STATUSES = [
  'pending',
  'submitted',
  'confirming',
  'completed',
  'failed',
  'expired',
  'cancelled',
  'recovery_required',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export type ActivityProjection = {
  ownerUserId: string;
  walletAddress: string;
  type: ActivityType;
  direction?: 'outgoing' | 'incoming';
  status: ActivityStatus;
  source: string;
  idempotencyKey: string;
  sourceReferenceType: string;
  sourceReferenceId: string;
  taskId?: string;
  operationId?: string;
  challengeId?: string;
  transactionId?: string;
  chainId?: number;
  txHash?: string;
  inputTokenSymbol?: string;
  inputTokenAddress?: string;
  inputAmount?: string;
  outputTokenSymbol?: string;
  outputTokenAddress?: string;
  outputAmount?: string;
  feeAmount?: string;
  feeTokenSymbol?: string;
  counterparty?: string;
  metadata?: Record<string, string | number | boolean>;
  occurredAt?: Date;
};

export type ActivitySyncSummary = {
  source: 'circle_w3s';
  status: 'synced' | 'throttled' | 'in_flight' | 'failed';
  pagesScanned: number;
  recordsScanned: number;
  recordsAccepted: number;
  checkpointAdvanced: boolean;
  retryAfterMs: number;
};

/**
 * Returned only from the authenticated synchronization endpoint.  The opaque
 * token is never persisted directly and is required for subsequent reads.
 */
export type ActivitySyncResult = ActivitySyncSummary & {
  readSessionToken: string;
};
