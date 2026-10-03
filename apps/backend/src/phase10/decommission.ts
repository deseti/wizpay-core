import { isIP } from 'node:net';
import {
  advance,
  FALLBACK_SHA,
  STAGES,
  publicOrigin,
  startCutover,
  verifyTarget,
  type Evidence,
  type Release,
  type TargetMetadata,
} from '../phase9/cutover';

export const TAG_OBJECT = '426befe96592a662e4656299b5aa83350d8c8044';
export const REQUIRED_CHECKS = [
  'productionHealth',
  'currentDataVerified',
  'financialEvidenceCurrent',
  'sourceWritesStopped',
  'targetWritesAuthoritative',
  'frontendBuildVerified',
  'noAutomaticFallback',
  'noStaleVpsBuild',
  'noVpsRequests',
  'recoveryDocumentation',
  'secretRecoverySecured',
  'legacyConfigArchived',
  'redisUnused',
  'bullmqUnused',
  'legacyWorkersUnused',
  'integrationInventoryComplete',
  'otherWizpayDependenciesAbsent',
  'hostWorkloadsInspected',
  'wizpayResourcesIsolated',
  'postShutdownChecksPrepared',
] as const;
export const INTEGRATION_IDS = [
  'vps-deploy',
  'host-cron-systemd',
  'analytics-scheduler',
  'reconciliation-scheduler',
  'provider-callbacks',
  'monitoring-probes',
] as const;
export type HostSharing = 'UNKNOWN' | 'YES' | 'NO';
export type Backup = {
  evidenceId: string;
  sha256: string;
  releaseSha: string;
  encrypted: boolean;
  offGit: boolean;
  restoreVerified: boolean;
  catalogVerified: boolean;
  countsVerified: boolean;
  integrityVerified: boolean;
};
export type DnsRecord = {
  name: string;
  type: 'A' | 'AAAA' | 'CNAME';
  answers: string[];
  active: boolean;
};
export type Routing = {
  frontendOrigin: string;
  frontendApiOrigin: string;
  vpsAddresses: string[];
  vpsHostnames: string[];
  requiredNames: string[];
  records: DnsRecord[];
  resolutionComplete: boolean;
};
export type Reconciliation = {
  pending: number;
  retryGrowth: number;
  expiredLeases: number;
  terminalFailures: number;
  idempotencyConflicts: number;
  approvedLimits: {
    pending: number;
    retryGrowth: number;
    expiredLeases: number;
    terminalFailures: number;
    idempotencyConflicts: number;
  };
  recentSuccessOrVerifiedEmptyBatch: boolean;
  schedulerIdentityVerified: boolean;
  enabledFeaturesRecovered: boolean;
};
export type DecommissionEvidence = {
  scope: 'LIVE' | 'OFFLINE';
  release: Release;
  phase9: {
    scope: 'LIVE' | 'OFFLINE';
    receipts: Evidence[];
    observationApprovedAndCompleted: boolean;
  };
  observedAt: string;
  validUntil: string;
  checks: Partial<Record<(typeof REQUIRED_CHECKS)[number], boolean>>;
  target: TargetMetadata;
  archive: { branchSha: string; tagSha: string; tagObject: string };
  backups: { vps: Backup; supabase: Backup };
  routing: Routing;
  reconciliation: Reconciliation;
  integrations: {
    id: string;
    active: boolean;
    pointsToVps: boolean;
    destinationHost: string | null;
  }[];
  hostSharing: HostSharing;
};
const sha = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safeId = (value: unknown) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const hostname = (value: string) =>
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(
    value,
  );
const dnsName = (value: string) => value.toLowerCase().replace(/\.$/, '');
function address(value: string) {
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6) return new URL(`http://[${value}]/`).hostname;
  throw new Error('IP_INVALID');
}
export function archiveVerified(input: DecommissionEvidence['archive']) {
  return (
    input?.branchSha === FALLBACK_SHA &&
    input?.tagSha === FALLBACK_SHA &&
    input?.tagObject === TAG_OBJECT
  );
}
export function backupVerified(input: Backup, releaseSha: string) {
  return Boolean(
    input &&
    safeId(input.evidenceId) &&
    /^[a-f0-9]{64}$/.test(input.sha256) &&
    input.releaseSha === releaseSha &&
    [
      input.encrypted,
      input.offGit,
      input.restoreVerified,
      input.catalogVerified,
      input.countsVerified,
      input.integrityVerified,
    ].every((value) => value === true),
  );
}
export function routingIndependent(input: Routing, release: Release) {
  try {
    if (
      input.resolutionComplete !== true ||
      publicOrigin(input.frontendOrigin) !== 'https://app.wizpay.xyz' ||
      publicOrigin(input.frontendApiOrigin) !== release.targetOrigin ||
      !input.vpsAddresses.length ||
      !input.vpsHostnames.length ||
      !input.requiredNames.length
    )
      return false;
    const ips = new Set(input.vpsAddresses.map(address));
    for (const ip of input.vpsAddresses)
      if (isIP(ip) === 4) ips.add(address(`::ffff:${ip}`));
    const hosts = new Set(input.vpsHostnames.map(dnsName));
    if (![...hosts, ...input.requiredNames].every((value) => hostname(value)))
      return false;
    const required = new Set([
      'app.wizpay.xyz',
      new URL(release.targetOrigin).hostname,
      ...input.requiredNames,
    ]);
    for (const name of required) {
      if (
        !input.records.some(
          (record) =>
            dnsName(record.name) === name &&
            record.active &&
            record.answers.length,
        )
      )
        return false;
    }
    function resolves(name: string, chain = new Set<string>()): boolean {
      if (chain.has(name) || chain.size >= 16 || hosts.has(name)) return false;
      const next = new Set(chain);
      next.add(name);
      return input.records.some(
        (record) =>
          record.active === true &&
          dnsName(record.name) === name &&
          record.answers.length > 0 &&
          (record.type === 'CNAME'
            ? record.answers.every((answer) => resolves(dnsName(answer), next))
            : record.answers.every(
                (answer) =>
                  isIP(answer) === (record.type === 'A' ? 4 : 6) &&
                  !ips.has(address(answer)),
              )),
      );
    }
    if ([...required].some((name) => !resolves(name))) return false;
    for (const record of input.records) {
      if (
        typeof record.active !== 'boolean' ||
        !hostname(dnsName(record.name)) ||
        !['A', 'AAAA', 'CNAME'].includes(record.type) ||
        !Array.isArray(record.answers)
      )
        return false;
      if (!record.active) continue; // Historical names require separate no-stale-client / no-production-request checks.
      if (hosts.has(dnsName(record.name))) return false;
      for (const answer of record.answers) {
        if (record.type === 'CNAME') {
          const target = dnsName(answer);
          if (
            !hostname(target) ||
            !resolves(target) ||
            hosts.has(target) ||
            !input.records.some(
              (row) =>
                row.active &&
                dnsName(row.name) === target &&
                row.answers.length,
            )
          )
            return false;
        } else if (
          isIP(answer) !== (record.type === 'A' ? 4 : 6) ||
          ips.has(address(answer))
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
export function reconciliationHealthy(input: Reconciliation) {
  return Boolean(
    input &&
    input.recentSuccessOrVerifiedEmptyBatch === true &&
    input.schedulerIdentityVerified === true &&
    input.enabledFeaturesRecovered === true &&
    [
      'pending',
      'retryGrowth',
      'expiredLeases',
      'terminalFailures',
      'idempotencyConflicts',
    ].every((key) => {
      const count = input[key] as number,
        limit = input.approvedLimits?.[key] as number;
      return (
        Number.isSafeInteger(count) &&
        count >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 0 &&
        count <= limit
      );
    }),
  );
}
export function phase9Accepted(
  input: DecommissionEvidence,
  expectedSha: string,
  scope: 'LIVE' | 'OFFLINE',
) {
  try {
    if (
      input.scope !== scope ||
      input.phase9.scope !== scope ||
      input.phase9.observationApprovedAndCompleted !== true ||
      input.phase9.receipts.length !== STAGES.length
    )
      return false;
    let state = startCutover(input.release, expectedSha, scope);
    for (let index = 0; index < STAGES.length; index++)
      state = advance(state, STAGES[index], input.phase9.receipts[index]);
    return state.decision === 'ACCEPTED';
  } catch {
    return false;
  }
}
/** Evidence evaluation only. No SSH, Docker control, provider mutations or billing API. */
export function evaluateDecommission(
  input: DecommissionEvidence,
  expectedSha: string,
  mode: 'LIVE' | 'OFFLINE' = 'LIVE',
  now = Date.now(),
) {
  const blocked: string[] = [];
  const check = (condition: unknown, code: string) => {
    if (condition !== true) blocked.push(code);
  };
  try {
    check(
      sha(expectedSha) && input.release?.candidateSha === expectedSha,
      'RELEASE_IDENTITY',
    );
    check(phase9Accepted(input, expectedSha, mode), 'PHASE9_LIVE_ACCEPTANCE');
    const observed = Date.parse(input.observedAt),
      expiry = Date.parse(input.validUntil);
    check(
      Number.isFinite(observed) &&
        Number.isFinite(expiry) &&
        observed <= now &&
        observed >= Date.parse(input.release.startedAt ?? '') &&
        expiry > now &&
        expiry > observed,
      'CURRENT_EVIDENCE',
    );
    for (const key of REQUIRED_CHECKS) check(input.checks?.[key] === true, key);
    let targetVerified = false;
    try {
      verifyTarget(input.target, input.release);
      targetVerified =
        input.target.sourceWritable === false &&
        input.target.targetReceivesProductionWrites === true;
    } catch {
      /* safe fixed reason only */
    }
    check(targetVerified, 'SUPABASE_AUTHORITY');
    check(archiveVerified(input.archive), 'ARCHIVE_IDENTITY');
    check(backupVerified(input.backups?.vps, FALLBACK_SHA), 'VPS_BACKUP');
    check(
      backupVerified(input.backups?.supabase, expectedSha),
      'CURRENT_SUPABASE_BACKUP',
    );
    check(
      routingIndependent(input.routing, input.release),
      'DNS_FRONTEND_INDEPENDENCE',
    );
    check(reconciliationHealthy(input.reconciliation), 'RECONCILIATION_HEALTH');
    check(
      Array.isArray(input.integrations) &&
        INTEGRATION_IDS.every((id) =>
          input.integrations.some((item) => item.id === id),
        ) &&
        input.integrations.every(
          (item) =>
            item.active === false ||
            (item.active === true &&
              item.pointsToVps === false &&
              typeof item.destinationHost === 'string' &&
              hostname(item.destinationHost) &&
              input.routing.records.some(
                (record) =>
                  record.active &&
                  dnsName(record.name) === item.destinationHost &&
                  record.answers.length,
              ) &&
              !input.routing.vpsHostnames
                .map(dnsName)
                .includes(dnsName(item.destinationHost))),
        ),
      'VPS_INTEGRATIONS',
    );
    check(
      input.hostSharing === 'YES' || input.hostSharing === 'NO',
      'HOST_SHARING_UNKNOWN',
    );
  } catch {
    blocked.push('EVIDENCE_MISSING_OR_INVALID');
  }
  const eligible = blocked.length === 0;
  const status =
    mode === 'OFFLINE'
      ? 'ELIGIBLE_IN_SIMULATION'
      : 'ELIGIBLE_FOR_OPERATOR_REVIEW';
  return {
    scope: mode === 'OFFLINE' ? 'OFFLINE_SIMULATION' : 'LIVE_EVIDENCE_REVIEW',
    decommission: eligible ? status : 'BLOCKED',
    subscriptionCancellation:
      eligible && input.hostSharing === 'NO' ? status : 'BLOCKED',
    blocked,
    subscriptionBlock:
      input?.hostSharing === 'NO' ? null : 'HOST_SHARING_NOT_NO',
    actionsExecuted: 0,
  };
}
