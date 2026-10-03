import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REQUIRED_CHECKS,
  TAG_OBJECT,
  evaluateDecommission,
  routingIndependent,
} from './decommission';
import { NOW, isolatedEvidence, simulateDecommission } from './fixtures';
import { parseRecoveryRefs } from './repository';
import { FALLBACK_SHA } from '../phase9/cutover';
import { repositoryRoot } from '../phase7/rehearsal-config';

describe('Phase 10 fail-closed decommission eligibility (no shutdown actions)', () => {
  const evaluate = (input = isolatedEvidence()) =>
    evaluateDecommission(input, input.release.candidateSha, 'OFFLINE', NOW);
  it('complete isolated evidence passes only simulation eligibility', () => {
    expect(evaluate()).toMatchObject({
      scope: 'OFFLINE_SIMULATION',
      decommission: 'ELIGIBLE_IN_SIMULATION',
      subscriptionCancellation: 'ELIGIBLE_IN_SIMULATION',
      actionsExecuted: 0,
    });
    const input = isolatedEvidence();
    expect(
      evaluateDecommission(input, input.release.candidateSha, 'LIVE', NOW)
        .decommission,
    ).toBe('BLOCKED');
  });
  it('missing Phase 9 live acceptance / incomplete observation blocks decommission', () => {
    const input = isolatedEvidence();
    input.phase9.receipts = [];
    expect(evaluate(input).blocked).toContain('PHASE9_LIVE_ACCEPTANCE');
    input.phase9 = isolatedEvidence().phase9;
    input.phase9.observationApprovedAndCompleted = false;
    expect(evaluate(input).decommission).toBe('BLOCKED');
  });
  it.each(REQUIRED_CHECKS)('missing required %s blocks decommission', (key) => {
    const input = isolatedEvidence();
    delete input.checks[key];
    expect(evaluate(input)).toMatchObject({ decommission: 'BLOCKED' });
    expect(evaluate(input).blocked).toContain(key);
  });
  it('missing/mismatched current or VPS backup blocks shutdown', () => {
    for (const name of ['supabase', 'vps'] as const) {
      for (const key of [
        'restoreVerified',
        'encrypted',
        'offGit',
        'catalogVerified',
        'countsVerified',
        'integrityVerified',
      ] as const) {
        const input = isolatedEvidence();
        input.backups[name][key] = false;
        expect(evaluate(input).decommission).toBe('BLOCKED');
      }
      const input = isolatedEvidence();
      input.backups[name].sha256 = '';
      expect(evaluate(input).decommission).toBe('BLOCKED');
    }
  });
  it('wrong archive branch, peeled tag or tag object blocks shutdown', () => {
    for (const key of ['branchSha', 'tagSha', 'tagObject'] as const) {
      const input = isolatedEvidence();
      input.archive[key] = 'f'.repeat(40);
      expect(evaluate(input).blocked).toContain('ARCHIVE_IDENTITY');
    }
  });
  it('read-only remote reference parsing preserves exact historical identities', () => {
    const output = `${FALLBACK_SHA}\trefs/heads/archive/vps-production\n${TAG_OBJECT}\trefs/tags/vps-production-9900052\n${FALLBACK_SHA}\trefs/tags/vps-production-9900052^{}`;
    expect(parseRecoveryRefs(output).result).toBe('PASS');
    expect(
      parseRecoveryRefs(output.replace(TAG_OBJECT, 'f'.repeat(40))).result,
    ).toBe('FAIL');
    expect(parseRecoveryRefs('')).toMatchObject({ result: 'FAIL' });
  });
  it('frontend VPS origin, stale build and automatic fallback each block shutdown', () => {
    const input = isolatedEvidence();
    input.routing.frontendApiOrigin = input.release.fallbackOrigin;
    expect(evaluate(input).blocked).toContain('DNS_FRONTEND_INDEPENDENCE');
    for (const key of ['noStaleVpsBuild', 'noAutomaticFallback'] as const) {
      const item = isolatedEvidence();
      item.checks[key] = false;
      expect(evaluate(item).decommission).toBe('BLOCKED');
    }
  });
  it('VPS A/AAAA/CNAME dependencies and missing resolution block shutdown', () => {
    const input = isolatedEvidence();
    input.routing.records[1].answers = ['203.0.113.10'];
    expect(evaluate(input).decommission).toBe('BLOCKED');
    input.routing.records[1] = {
      name: 'fixture.vercel.app',
      type: 'AAAA',
      answers: ['::ffff:203.0.113.10'],
      active: true,
    };
    expect(evaluate(input).decommission).toBe('BLOCKED');
    input.routing.records[0].answers = ['vps.offline.invalid'];
    expect(evaluate(input).decommission).toBe('BLOCKED');
    const clean = isolatedEvidence();
    clean.routing.resolutionComplete = false;
    expect(routingIndependent(clean.routing, clean.release)).toBe(false);
  });
  it('unknown VPS addresses or unresolved CNAME chain fail closed', () => {
    const input = isolatedEvidence();
    input.routing.vpsAddresses = [];
    expect(evaluate(input).decommission).toBe('BLOCKED');
    const clean = isolatedEvidence();
    clean.routing.records.splice(1, 1);
    expect(evaluate(clean).decommission).toBe('BLOCKED');
  });
  it('manually supplied cyclic DNS or nonboolean resolution evidence cannot pass', () => {
    const input = isolatedEvidence();
    input.routing.records[1] = {
      name: 'fixture.vercel.app',
      type: 'CNAME',
      answers: ['app.wizpay.xyz'],
      active: true,
    };
    expect(evaluate(input).decommission).toBe('BLOCKED');
    const clean = isolatedEvidence();
    Object.assign(clean.routing, { resolutionComplete: 'true' });
    expect(evaluate(clean).decommission).toBe('BLOCKED');
  });
  it('Supabase non-authority, simultaneous writes or wrong network blocks shutdown', () => {
    for (const change of [
      { targetReceivesProductionWrites: false },
      { sourceWritable: true },
      { project: 'aaaaaaaaaaaaaaaaaaaa' },
      { network: 'arc-testnet' },
    ]) {
      const input = isolatedEvidence();
      input.target = { ...input.target, ...change };
      expect(evaluate(input).blocked).toContain('SUPABASE_AUTHORITY');
    }
  });
  it('unhealthy reconciliation, missing successful batch or invalid limits blocks shutdown', () => {
    for (const key of [
      'pending',
      'retryGrowth',
      'expiredLeases',
      'terminalFailures',
      'idempotencyConflicts',
    ] as const) {
      const input = isolatedEvidence();
      input.reconciliation[key] = 1;
      expect(evaluate(input).blocked).toContain('RECONCILIATION_HEALTH');
    }
    const input = isolatedEvidence();
    input.reconciliation.recentSuccessOrVerifiedEmptyBatch = false;
    expect(evaluate(input).decommission).toBe('BLOCKED');
  });
  it('Redis or BullMQ/legacy workers cannot be required by enabled features', () => {
    for (const key of [
      'redisUnused',
      'bullmqUnused',
      'legacyWorkersUnused',
      'otherWizpayDependenciesAbsent',
    ] as const) {
      const input = isolatedEvidence();
      input.checks[key] = false;
      expect(evaluate(input).decommission).toBe('BLOCKED');
    }
  });
  it('active webhook, SSH deployment, scheduler or unresolved integration target blocks shutdown', () => {
    const input = isolatedEvidence();
    input.integrations[0] = {
      id: 'vps-deploy',
      active: true,
      pointsToVps: true,
      destinationHost: 'vps.offline.invalid',
    };
    expect(evaluate(input).blocked).toContain('VPS_INTEGRATIONS');
    input.integrations[0] = {
      id: 'vps-deploy',
      active: true,
      pointsToVps: false,
      destinationHost: 'unknown.example.com',
    };
    expect(evaluate(input).blocked).toContain('VPS_INTEGRATIONS');
    input.integrations = [];
    expect(evaluate(input).decommission).toBe('BLOCKED');
  });
  it('missing recovery documentation/secret recovery blocks shutdown', () => {
    const input = isolatedEvidence();
    delete input.checks.recoveryDocumentation;
    expect(evaluate(input).decommission).toBe('BLOCKED');
    input.checks.recoveryDocumentation = true;
    input.checks.secretRecoverySecured = false;
    expect(evaluate(input).decommission).toBe('BLOCKED');
  });
  it('UNKNOWN sharing blocks; YES permits only isolated WizPay workloads; NO permits cancellation review', () => {
    const input = isolatedEvidence();
    input.hostSharing = 'UNKNOWN';
    expect(evaluate(input)).toMatchObject({
      decommission: 'BLOCKED',
      subscriptionCancellation: 'BLOCKED',
    });
    input.hostSharing = 'YES';
    expect(evaluate(input)).toMatchObject({
      decommission: 'ELIGIBLE_IN_SIMULATION',
      subscriptionCancellation: 'BLOCKED',
    });
    input.checks.wizpayResourcesIsolated = false;
    expect(evaluate(input).decommission).toBe('BLOCKED');
    input.checks.wizpayResourcesIsolated = true;
    input.hostSharing = 'NO';
    expect(evaluate(input).subscriptionCancellation).toBe(
      'ELIGIBLE_IN_SIMULATION',
    );
  });
  it('wrong release or stale evidence blocks eligibility', () => {
    const input = isolatedEvidence();
    expect(
      evaluateDecommission(input, 'f'.repeat(40), 'OFFLINE', NOW).decommission,
    ).toBe('BLOCKED');
    input.validUntil = '2026-10-03T10:00:00.000Z';
    expect(evaluate(input).decommission).toBe('BLOCKED');
  });
  it('simulation performs zero network calls and exercises all 13 outcomes', () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    try {
      expect(simulateDecommission()).toMatchObject({
        result: 'PASS',
        productionContacts: 0,
        productionChanges: 0,
      });
      expect(simulateDecommission().cases).toHaveLength(13);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('safe summaries never emit supplied passwords, URLs or raw evidence', () => {
    const input = isolatedEvidence();
    input.release.deploymentId =
      'postgresql://u:never-print@private.invalid/db';
    expect(JSON.stringify(evaluate(input))).not.toContain('never-print');
    expect(evaluate(input).decommission).toBe('BLOCKED');
  });
});

describe('compiled Phase 10 CLI', () => {
  function cli(args: string[]) {
    try {
      return {
        status: 0,
        output: execFileSync(
          process.execPath,
          [join(repositoryRoot, 'apps/backend/dist/phase10/cli.js'), ...args],
          {
            cwd: repositoryRoot,
            env: { PATH: process.env.PATH },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
          },
        ),
      };
    } catch (error) {
      const result = error as {
        status: number;
        stdout: string;
        stderr: string;
      };
      return { status: result.status, output: result.stdout + result.stderr };
    }
  }
  it('defaults to BLOCKED with no remote shutdown/deletion/billing command', () => {
    expect(cli([])).toMatchObject({ status: 1 });
    expect(cli([]).output).toContain('LIVE_EVIDENCE_REQUIRED');
    const directory = mkdtempSync(join(tmpdir(), 'p10-cli-'));
    const path = join(directory, 'input.json');
    try {
      writeFileSync(path, JSON.stringify({ password: 'do-not-print' }), {
        mode: 0o600,
      });
      for (const command of [
        '--stop',
        '--shutdown',
        '--delete',
        '--cancel',
        '--force',
        '--skip',
        '--dns-check',
      ]) {
        const result = cli([command, path]);
        expect(result.status).toBe(1);
        expect(result.output).not.toContain('do-not-print');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('compiled simulation is explicitly offline and cannot perform decommission', () => {
    const result = cli(['--simulate']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output) as unknown).toMatchObject({
      result: 'PASS',
      actualDecommission: 'NOT_EXECUTED',
      productionContacts: 0,
    });
  });
});
