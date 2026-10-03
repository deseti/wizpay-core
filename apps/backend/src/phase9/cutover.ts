import { createHash } from 'node:crypto';
import { loadBackendArcNetworkConfiguration } from '../config/arc-network.config';

export const FALLBACK_SHA = '9900052a04ba807d937a9687f21d9933ffee33dd';
export const FEATURE_BRANCH = 'feat/serverless-free-stack';
export const STAGES = [
  'PRECHECK',
  'DATABASE_EXPORT',
  'DATABASE_IMPORT',
  'DATABASE_VERIFY',
  'VERCEL_VERIFY',
  'TARGET_SMOKE',
  'FRONTEND_SWITCH',
  'PRODUCTION_SMOKE',
  'OBSERVATION',
  'ACCEPT',
] as const;
export type Stage = (typeof STAGES)[number];
export type Scope = 'OFFLINE' | 'LIVE';
export type Evidence = {
  id: string;
  candidateSha: string;
  scope: Scope;
  checks: Record<string, boolean>;
  targetWrites?: 'NONE' | 'PRESENT' | 'UNKNOWN';
};
export const STABLE_CAPABILITIES = [
  'send',
  'sameTokenPayroll',
  'invoice',
  'paymentLink',
  'swap',
  'bridge',
  'crossTokenPayroll',
] as const;
export type Release = {
  approvedCapabilities: Record<string, boolean>;
  candidateSha: string;
  fallbackSha: string;
  acceptanceDigest: string;
  resourceDigest: string;
  deploymentId: string | null;
  migrationEvidenceId: string | null;
  startedAt: string | null;
  targetProject: string;
  targetOrigin: string;
  fallbackOrigin: string;
};
export type CutoverState = {
  release: Release;
  scope: Scope;
  stages: readonly Stage[];
  evidenceIds: readonly string[];
  authority: 'VPS' | 'FENCED' | 'TARGET';
  targetWrites: 'NONE' | 'PRESENT' | 'UNKNOWN';
  decision: 'OPEN' | 'ACCEPTED' | 'ROLLBACK_READY' | 'RECONCILIATION_REQUIRED';
};

export const CHECKS: Record<Stage, readonly string[]> = {
  PRECHECK: [
    'repository',
    'fallback',
    'phase6',
    'phase7',
    'phase8',
    'configuration',
    'rollback',
  ],
  DATABASE_EXPORT: [
    'sourceFenced',
    'backgroundFenced',
    'readOnlySource',
    'consistentSnapshot',
    'backupVerified',
  ],
  DATABASE_IMPORT: [
    'sourceStillFenced',
    'targetIdentity',
    'targetClean',
    'schemaPrepared',
    'importPassed',
  ],
  DATABASE_VERIFY: [
    'allCounts',
    'allColumns',
    'constraints',
    'indexes',
    'enums',
    'migrationHistory',
    'financialIdentities',
    'leasesPreserved',
  ],
  VERCEL_VERIFY: [
    'releaseIdentity',
    'deploymentIdentity',
    'supabaseIdentity',
    'serverless',
    'redisFree',
    'mainnet',
    'resources',
    'noVpsProxy',
    'cors',
  ],
  TARGET_SMOKE: [
    'health',
    'capabilities',
    'database',
    'arcRpc',
    'enabledIntegrations',
    'authorization',
    'noFundMovement',
  ],
  FRONTEND_SWITCH: [
    'sourceStillFenced',
    'backgroundStillFenced',
    'oneWriteAuthority',
    'explicitTarget',
    'frontendRebuilt',
    'oldClientsFenced',
    'rollbackAvailable',
  ],
  PRODUCTION_SMOKE: [
    'health',
    'capabilities',
    'publicCheckout',
    'auth',
    'activity',
    'enabledPrepareFlows',
    'reconciliationReadiness',
    'noFundMovement',
  ],
  OBSERVATION: [
    'approvedWindowComplete',
    'metricsReviewed',
    'criticalFlowsHealthy',
    'noDivergence',
    'rollbackAvailable',
  ],
  ACCEPT: ['ownerDecision', 'evidenceComplete', 'vpsStillAvailable'],
};

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
export function resourceDigest(): string {
  // Registry identity, including RPC/tokens/contracts; no provider overrides.
  return createHash('sha256')
    .update(
      JSON.stringify(
        loadBackendArcNetworkConfiguration({
          WIZPAY_ARC_NETWORK: 'arc-mainnet',
        }),
      ),
    )
    .digest('hex');
}
export function publicOrigin(value: string): string {
  try {
    const url = new URL(value);
    requireCondition(
      url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/',
      'ORIGIN_INVALID',
    );
    return url.origin;
  } catch {
    throw new Error('ORIGIN_INVALID');
  }
}
export function validateRelease(release: Release, expectedSha: string) {
  requireCondition(
    /^[a-f0-9]{40}$/.test(expectedSha) && release.candidateSha === expectedSha,
    'CANDIDATE_MISMATCH',
  );
  requireCondition(release.fallbackSha === FALLBACK_SHA, 'FALLBACK_MISMATCH');
  requireCondition(
    /^[a-f0-9]{64}$/.test(release.acceptanceDigest),
    'ACCEPTANCE_MISSING',
  );
  requireCondition(
    release.resourceDigest === resourceDigest(),
    'RESOURCE_MISMATCH',
  );
  requireCondition(
    /^[a-z]{20}$/.test(release.targetProject),
    'DATABASE_IDENTITY_INVALID',
  );
  requireCondition(
    STABLE_CAPABILITIES.every(
      (key) => typeof release.approvedCapabilities?.[key] === 'boolean',
    ) &&
      Object.keys(release.approvedCapabilities).length ===
        STABLE_CAPABILITIES.length,
    'CAPABILITY_PROFILE_INVALID',
  );
  const target = publicOrigin(release.targetOrigin);
  requireCondition(
    new URL(target).hostname.endsWith('.vercel.app'),
    'TARGET_INVALID',
  );
  requireCondition(
    publicOrigin(release.fallbackOrigin) !== target,
    'SPLIT_BRAIN',
  );
  for (const id of [release.deploymentId, release.migrationEvidenceId]) {
    requireCondition(
      id === null || /^[a-zA-Z0-9_-]{1,100}$/.test(id),
      'IDENTITY_INVALID',
    );
  }
  requireCondition(
    release.startedAt === null ||
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(release.startedAt),
    'TIMESTAMP_INVALID',
  );
}
export function startCutover(
  release: Release,
  expectedSha: string,
  scope: Scope = 'OFFLINE',
): CutoverState {
  validateRelease(release, expectedSha);
  requireCondition(scope === 'OFFLINE' || scope === 'LIVE', 'SCOPE_INVALID');
  if (scope === 'LIVE') {
    requireCondition(
      release.deploymentId && release.migrationEvidenceId && release.startedAt,
      'LIVE_IDENTITY_MISSING',
    );
  }
  return Object.freeze({
    release: Object.freeze({
      ...release,
      approvedCapabilities: Object.freeze({ ...release.approvedCapabilities }),
    }),
    scope,
    stages: Object.freeze([]),
    evidenceIds: Object.freeze([]),
    authority: 'VPS',
    targetWrites: 'NONE',
    decision: 'OPEN',
  });
}
export function advance(
  state: CutoverState,
  stage: Stage,
  evidence: Evidence,
): CutoverState {
  requireCondition(state.decision === 'OPEN', 'DECISION_LOCKED');
  requireCondition(STAGES[state.stages.length] === stage, 'GATE_ORDER');
  requireCondition(
    evidence.scope === state.scope &&
      evidence.candidateSha === state.release.candidateSha,
    'EVIDENCE_IDENTITY',
  );
  requireCondition(
    /^[a-zA-Z0-9_-]{1,100}$/.test(evidence.id) &&
      !state.evidenceIds.includes(evidence.id),
    'EVIDENCE_ID_INVALID',
  );
  requireCondition(
    evidence.targetWrites === undefined ||
      ['NONE', 'PRESENT', 'UNKNOWN'].includes(evidence.targetWrites),
    'WRITE_STATE_INVALID',
  );
  requireCondition(
    CHECKS[stage].every((key) => evidence.checks[key] === true),
    'GATE_FAILED',
  );
  if (state.scope === 'LIVE') {
    requireCondition(
      state.release.deploymentId &&
        state.release.migrationEvidenceId &&
        state.release.startedAt,
      'LIVE_IDENTITY_MISSING',
    );
  }
  return Object.freeze({
    ...state,
    stages: Object.freeze([...state.stages, stage]),
    evidenceIds: Object.freeze([...state.evidenceIds, evidence.id]),
    authority:
      stage === 'DATABASE_EXPORT'
        ? 'FENCED'
        : stage === 'FRONTEND_SWITCH'
          ? 'TARGET'
          : state.authority,
    // Smoke may persist nonce/session/expiry metadata; traffic never implies no writes.
    targetWrites:
      state.targetWrites === 'PRESENT' || evidence.targetWrites === 'PRESENT'
        ? 'PRESENT'
        : stage === 'TARGET_SMOKE' ||
            stage === 'FRONTEND_SWITCH' ||
            stage === 'PRODUCTION_SMOKE'
          ? 'UNKNOWN'
          : state.targetWrites,
    decision: stage === 'ACCEPT' ? 'ACCEPTED' : 'OPEN',
  });
}
export function noteTargetWrites(
  state: CutoverState,
  writes: CutoverState['targetWrites'],
): CutoverState {
  requireCondition(state.decision === 'OPEN', 'DECISION_LOCKED');
  requireCondition(
    ['NONE', 'PRESENT', 'UNKNOWN'].includes(writes),
    'WRITE_STATE_INVALID',
  );
  requireCondition(
    (state.targetWrites !== 'PRESENT' || writes === 'PRESENT') &&
      (writes !== 'NONE' || state.targetWrites === 'NONE'),
    'WRITES_CANNOT_BE_ERASED',
  );
  return Object.freeze({ ...state, targetWrites: writes });
}
export function rollback(
  state: CutoverState,
  noWritesProven: boolean,
): CutoverState {
  requireCondition(state.decision === 'OPEN', 'DECISION_LOCKED');
  const clean = state.targetWrites !== 'PRESENT' && noWritesProven;
  // A recommendation/evidence record only. This function never changes routing or a DB.
  return Object.freeze({
    ...state,
    authority: 'FENCED',
    decision: clean ? 'ROLLBACK_READY' : 'RECONCILIATION_REQUIRED',
  });
}

export type TargetMetadata = {
  project: string;
  database: string;
  port: number;
  userProject: string;
  mode: string;
  network: string;
  chainId: number;
  profile: string;
  cors: string;
  resourceDigest: string;
  sourceWritable: boolean;
  targetReceivesProductionWrites: boolean;
  redisConfigured: boolean;
  vpsProxy: boolean;
};
export function verifyTarget(metadata: TargetMetadata, release: Release) {
  requireCondition(
    metadata.project === release.targetProject &&
      metadata.userProject === release.targetProject &&
      metadata.database === 'postgres' &&
      metadata.port === 6543 &&
      metadata.profile === 'supavisor-transaction',
    'DATABASE_TARGET_MISMATCH',
  );
  requireCondition(
    metadata.mode === 'serverless' &&
      !metadata.redisConfigured &&
      !metadata.vpsProxy,
    'RUNTIME_INVALID',
  );
  requireCondition(
    metadata.network === 'arc-mainnet' &&
      metadata.chainId === 5042 &&
      metadata.resourceDigest === release.resourceDigest,
    'NETWORK_RESOURCE_MISMATCH',
  );
  requireCondition(metadata.cors === 'https://app.wizpay.xyz', 'CORS_INVALID');
  requireCondition(
    !(metadata.sourceWritable && metadata.targetReceivesProductionWrites),
    'SPLIT_BRAIN',
  );
}

export const METRICS = [
  'http5xx',
  'coldStarts',
  'database',
  'prisma',
  'arcRpc',
  'verification',
  'reconciliationRetries',
  'stuckLeases',
  'idempotencyConflicts',
  'auth',
  'invoicePayment',
  'swapPayrollBridge',
] as const;
export type Observation = {
  windowApproved: boolean;
  windowComplete: boolean;
  samples: Record<
    (typeof METRICS)[number],
    { count: number; approvedLimit: number }
  >;
};
export function summarizeObservation(input: Observation) {
  const healthy = METRICS.every((key) => {
    const sample = input.samples[key];
    return (
      sample &&
      Number.isSafeInteger(sample.count) &&
      sample.count >= 0 &&
      Number.isSafeInteger(sample.approvedLimit) &&
      sample.approvedLimit >= 0 &&
      sample.count <= sample.approvedLimit
    );
  });
  return {
    result:
      input.windowApproved === true && input.windowComplete === true && healthy
        ? 'PASS'
        : 'HOLD_OR_ROLLBACK',
    metrics: METRICS.length,
  };
}
