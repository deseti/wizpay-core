// Synthetic release metadata for offline tests only. No environment values.
import {
  CHECKS,
  FALLBACK_SHA,
  resourceDigest,
  type Release,
  type Stage,
  type TargetMetadata,
} from './cutover';
export const candidate = '25b518217b46a7d45462c6fc610314b73a32a5c5';
export function fixtureRelease(): Release {
  return {
    approvedCapabilities: {
      send: true,
      sameTokenPayroll: true,
      invoice: true,
      paymentLink: true,
      swap: true,
      bridge: true,
      crossTokenPayroll: true,
    },
    candidateSha: candidate,
    fallbackSha: FALLBACK_SHA,
    acceptanceDigest: 'a'.repeat(64),
    resourceDigest: resourceDigest(),
    deploymentId: 'offline_fixture',
    migrationEvidenceId: 'offline_migration',
    startedAt: '2026-10-03T00:00:00.000Z',
    targetProject: 'tsvzblikmgocgksgxguc',
    targetOrigin: 'https://fixture.vercel.app',
    fallbackOrigin: 'https://vps.offline.invalid',
  };
}
export function fixtureMetadata(): TargetMetadata {
  return {
    project: 'tsvzblikmgocgksgxguc',
    userProject: 'tsvzblikmgocgksgxguc',
    database: 'postgres',
    port: 6543,
    profile: 'supavisor-transaction',
    mode: 'serverless',
    network: 'arc-mainnet',
    chainId: 5042,
    resourceDigest: resourceDigest(),
    cors: 'https://app.wizpay.xyz',
    sourceWritable: false,
    targetReceivesProductionWrites: false,
    redisConfigured: false,
    vpsProxy: false,
  };
}
export function evidence(stage: Stage) {
  return {
    id: `offline_${stage}`,
    candidateSha: candidate,
    scope: 'OFFLINE' as const,
    checks: Object.fromEntries(CHECKS[stage].map((key) => [key, true])),
  };
}
