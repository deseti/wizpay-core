// Synthetic evidence only; never a live observation or production acceptance.
import { CHECKS, FALLBACK_SHA, STAGES } from '../phase9/cutover';
import { fixtureRelease, fixtureMetadata } from '../phase9/fixtures';
import {
  INTEGRATION_IDS,
  REQUIRED_CHECKS,
  TAG_OBJECT,
  evaluateDecommission,
  type DecommissionEvidence,
} from './decommission';
export const NOW = Date.parse('2026-10-03T12:00:00.000Z');
export function isolatedEvidence(): DecommissionEvidence {
  const release = fixtureRelease();
  const backup = {
    evidenceId: 'synthetic_backup',
    sha256: 'a'.repeat(64),
    releaseSha: release.candidateSha,
    encrypted: true,
    offGit: true,
    restoreVerified: true,
    catalogVerified: true,
    countsVerified: true,
    integrityVerified: true,
  };
  return {
    scope: 'OFFLINE',
    release,
    observedAt: '2026-10-03T11:59:00.000Z',
    validUntil: '2026-10-03T13:00:00.000Z',
    phase9: {
      scope: 'OFFLINE',
      observationApprovedAndCompleted: true,
      receipts: STAGES.map((stage) => ({
        id: `offline_${stage}`,
        candidateSha: release.candidateSha,
        scope: 'OFFLINE',
        checks: Object.fromEntries(CHECKS[stage].map((key) => [key, true])),
      })),
    },
    checks: Object.fromEntries(REQUIRED_CHECKS.map((key) => [key, true])),
    target: { ...fixtureMetadata(), targetReceivesProductionWrites: true },
    archive: {
      branchSha: FALLBACK_SHA,
      tagSha: FALLBACK_SHA,
      tagObject: TAG_OBJECT,
    },
    backups: { vps: { ...backup, releaseSha: FALLBACK_SHA }, supabase: backup },
    routing: {
      frontendOrigin: 'https://app.wizpay.xyz',
      frontendApiOrigin: release.targetOrigin,
      vpsAddresses: ['203.0.113.10'],
      vpsHostnames: ['vps.offline.invalid'],
      requiredNames: ['app.wizpay.xyz', 'fixture.vercel.app'],
      resolutionComplete: true,
      records: [
        {
          name: 'app.wizpay.xyz',
          type: 'CNAME',
          answers: ['fixture.vercel.app'],
          active: true,
        },
        {
          name: 'fixture.vercel.app',
          type: 'A',
          answers: ['192.0.2.10'],
          active: true,
        },
      ],
    },
    reconciliation: {
      pending: 0,
      retryGrowth: 0,
      expiredLeases: 0,
      terminalFailures: 0,
      idempotencyConflicts: 0,
      approvedLimits: {
        pending: 0,
        retryGrowth: 0,
        expiredLeases: 0,
        terminalFailures: 0,
        idempotencyConflicts: 0,
      },
      recentSuccessOrVerifiedEmptyBatch: true,
      schedulerIdentityVerified: true,
      enabledFeaturesRecovered: true,
    },
    integrations: INTEGRATION_IDS.map((id) => ({
      id,
      active: id === 'reconciliation-scheduler',
      pointsToVps: false,
      destinationHost:
        id === 'reconciliation-scheduler' ? 'fixture.vercel.app' : null,
    })),
    hostSharing: 'NO',
  };
}
export function simulateDecommission() {
  const cases = [
    {
      name: 'complete',
      change: () => undefined,
      expected: 'ELIGIBLE_IN_SIMULATION',
    },
    {
      name: 'phase9-missing',
      change: (input: DecommissionEvidence) => {
        input.phase9.receipts = [];
      },
      expected: 'BLOCKED',
    },
    {
      name: 'supabase-not-authoritative',
      change: (input: DecommissionEvidence) => {
        input.target.targetReceivesProductionWrites = false;
      },
      expected: 'BLOCKED',
    },
    {
      name: 'dns-vps',
      change: (input: DecommissionEvidence) => {
        input.routing.records[1].answers = ['203.0.113.10'];
      },
      expected: 'BLOCKED',
    },
    {
      name: 'frontend-vps',
      change: (input: DecommissionEvidence) => {
        input.routing.frontendApiOrigin = input.release.fallbackOrigin;
      },
      expected: 'BLOCKED',
    },
    {
      name: 'unhealthy-reconciliation',
      change: (input: DecommissionEvidence) => {
        input.reconciliation.expiredLeases = 1;
      },
      expected: 'BLOCKED',
    },
    {
      name: 'redis',
      change: (input: DecommissionEvidence) => {
        input.checks.redisUnused = false;
      },
      expected: 'BLOCKED',
    },
    {
      name: 'bullmq',
      change: (input: DecommissionEvidence) => {
        input.checks.bullmqUnused = false;
      },
      expected: 'BLOCKED',
    },
    {
      name: 'webhook-vps',
      change: (input: DecommissionEvidence) => {
        input.integrations[0] = {
          id: 'vps-deploy',
          active: true,
          pointsToVps: true,
          destinationHost: 'vps.offline.invalid',
        };
      },
      expected: 'BLOCKED',
    },
    {
      name: 'backup-missing',
      change: (input: DecommissionEvidence) => {
        input.backups.vps.restoreVerified = false;
      },
      expected: 'BLOCKED',
    },
    {
      name: 'archive-mismatch',
      change: (input: DecommissionEvidence) => {
        input.archive.tagSha = 'f'.repeat(40);
      },
      expected: 'BLOCKED',
    },
    {
      name: 'sharing-unknown',
      change: (input: DecommissionEvidence) => {
        input.hostSharing = 'UNKNOWN';
      },
      expected: 'BLOCKED',
    },
    {
      name: 'sharing-yes',
      change: (input: DecommissionEvidence) => {
        input.hostSharing = 'YES';
      },
      expected: 'ELIGIBLE_IN_SIMULATION',
    },
  ];
  const results = cases.map((item) => {
    const input = isolatedEvidence();
    item.change(input);
    const result = evaluateDecommission(
      input,
      input.release.candidateSha,
      'OFFLINE',
      NOW,
    );
    return {
      case: item.name,
      passed:
        result.decommission === item.expected &&
        (item.name !== 'sharing-yes' ||
          result.subscriptionCancellation === 'BLOCKED'),
      decommission: result.decommission,
      subscriptionCancellation: result.subscriptionCancellation,
    };
  });
  return {
    scope: 'OFFLINE_SIMULATION',
    result: results.every((item) => item.passed) ? 'PASS' : 'FAIL',
    cases: results,
    productionContacts: 0,
    productionChanges: 0,
    actualDecommission: 'NOT_EXECUTED',
  };
}
