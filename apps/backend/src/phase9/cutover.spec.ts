import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  advance,
  CHECKS,
  FALLBACK_SHA,
  METRICS,
  STAGES,
  noteTargetWrites,
  rollback,
  startCutover,
  summarizeObservation,
  validateRelease,
  verifyTarget,
  type Stage,
} from './cutover';
import { acceptancePassed, preflight } from './preflight';
import { offlineSimulation } from './cli';
import { repositoryRoot } from '../phase7/rehearsal-config';

import {
  candidate,
  evidence,
  fixtureMetadata,
  fixtureRelease,
} from './fixtures';
function at(stage: Stage) {
  let state = startCutover(fixtureRelease(), candidate);
  for (const item of STAGES) {
    if (item === stage) return state;
    state = advance(state, item, evidence(item));
  }
  return state;
}

describe('Phase 9 cutover gates (records only, never production actions)', () => {
  it('rejects wrong candidate and pins fallback tag identity', () => {
    expect(() => validateRelease(fixtureRelease(), 'f'.repeat(40))).toThrow(
      'CANDIDATE_MISMATCH',
    );
    expect(() =>
      startCutover(
        { ...fixtureRelease(), fallbackSha: 'f'.repeat(40) },
        candidate,
      ),
    ).toThrow('FALLBACK_MISMATCH');
  });
  it('rejects missing acceptance and validates every Phase 8 feature result', () => {
    expect(() =>
      startCutover({ ...fixtureRelease(), acceptanceDigest: '' }, candidate),
    ).toThrow('ACCEPTANCE_MISSING');
    const report = {
      baseline_sha: FALLBACK_SHA,
      implementation_acceptance: 'PASS',
      features: Array.from({ length: 32 }, () => ({ result: 'PASS' })),
    };
    expect(acceptancePassed(report)).toBe(true);
    expect(
      acceptancePassed({ ...report, implementation_acceptance: 'FAIL' }),
    ).toBe(false);
    expect(
      acceptancePassed({ ...report, features: [{ result: 'FAIL' }] }),
    ).toBe(false);
  });
  it.each(STAGES)(
    'requires every %s prerequisite, including DB integrity and health',
    (stage) => {
      const state = at(stage);
      for (const key of CHECKS[stage]) {
        const receipt = evidence(stage);
        receipt.checks[key] = false;
        expect(() => advance(state, stage, receipt)).toThrow('GATE_FAILED');
        expect(state.stages).not.toContain(stage);
      }
      expect(advance(state, stage, evidence(stage)).stages).toContain(stage);
    },
  );
  it('cannot switch frontend before DB or target verification', () => {
    expect(() =>
      advance(
        at('DATABASE_VERIFY'),
        'FRONTEND_SWITCH',
        evidence('FRONTEND_SWITCH'),
      ),
    ).toThrow('GATE_ORDER');
    expect(() =>
      advance(
        at('TARGET_SMOKE'),
        'FRONTEND_SWITCH',
        evidence('FRONTEND_SWITCH'),
      ),
    ).toThrow('GATE_ORDER');
  });
  it('rejects mixed scope, wrong release and repeated evidence', () => {
    expect(() =>
      advance(at('PRECHECK'), 'PRECHECK', {
        ...evidence('PRECHECK'),
        scope: 'LIVE',
      }),
    ).toThrow('EVIDENCE_IDENTITY');
    expect(() =>
      advance(at('PRECHECK'), 'PRECHECK', {
        ...evidence('PRECHECK'),
        candidateSha: 'f'.repeat(40),
      }),
    ).toThrow('EVIDENCE_IDENTITY');
    expect(() =>
      advance(at('DATABASE_EXPORT'), 'DATABASE_EXPORT', {
        ...evidence('DATABASE_EXPORT'),
        id: 'offline_PRECHECK',
      }),
    ).toThrow('EVIDENCE_ID_INVALID');
  });
  it.each([
    ['database', 'vps'],
    ['project', 'aaaaaaaaaaaaaaaaaaaa'],
    ['userProject', 'aaaaaaaaaaaaaaaaaaaa'],
    ['port', 5432],
    ['network', 'arc-testnet'],
    ['chainId', 5042002],
    ['mode', 'server'],
    ['redisConfigured', true],
    ['vpsProxy', true],
    ['resourceDigest', 'f'.repeat(64)],
    ['cors', '*'],
  ])('rejects incorrect target %s', (key, value) => {
    expect(() =>
      verifyTarget({ ...fixtureMetadata(), [key]: value }, fixtureRelease()),
    ).toThrow();
  });
  it('rejects simultaneous writable production targets', () => {
    expect(() =>
      verifyTarget(
        {
          ...fixtureMetadata(),
          sourceWritable: true,
          targetReceivesProductionWrites: true,
        },
        fixtureRelease(),
      ),
    ).toThrow('SPLIT_BRAIN');
    expect(() =>
      startCutover(
        { ...fixtureRelease(), fallbackOrigin: fixtureRelease().targetOrigin },
        candidate,
      ),
    ).toThrow('SPLIT_BRAIN');
  });
  it('preserves one authority and requires independent live identity', () => {
    expect(at('DATABASE_IMPORT').authority).toBe('FENCED');
    expect(at('PRODUCTION_SMOKE').authority).toBe('TARGET');
    expect(() =>
      startCutover(
        { ...fixtureRelease(), deploymentId: null },
        candidate,
        'LIVE',
      ),
    ).toThrow('LIVE_IDENTITY_MISSING');
  });
  it('permits rollback A only with no-write proof; requires reconciliation after target writes', () => {
    expect(rollback(at('FRONTEND_SWITCH'), true).decision).toBe(
      'ROLLBACK_READY',
    );
    expect(rollback(at('PRODUCTION_SMOKE'), false).decision).toBe(
      'RECONCILIATION_REQUIRED',
    );
    const written = noteTargetWrites(at('PRODUCTION_SMOKE'), 'PRESENT');
    expect(rollback(written, true)).toMatchObject({
      decision: 'RECONCILIATION_REQUIRED',
      authority: 'FENCED',
    });
    expect(() => noteTargetWrites(written, 'UNKNOWN')).toThrow(
      'WRITES_CANNOT_BE_ERASED',
    );
    expect(() => noteTargetWrites(written, 'NONE')).toThrow(
      'WRITES_CANNOT_BE_ERASED',
    );
  });
  it('observation failure recommends holding/rollback, with approved limits for every metric', () => {
    const samples = Object.fromEntries(
      METRICS.map((key) => [key, { count: 0, approvedLimit: 0 }]),
    ) as Parameters<typeof summarizeObservation>[0]['samples'];
    expect(
      summarizeObservation({
        windowApproved: true,
        windowComplete: true,
        samples,
      }).result,
    ).toBe('PASS');
    samples.verification.count = 1;
    expect(
      summarizeObservation({
        windowApproved: true,
        windowComplete: true,
        samples,
      }).result,
    ).toBe('HOLD_OR_ROLLBACK');
    expect(
      summarizeObservation({
        windowApproved: false,
        windowComplete: true,
        samples,
      }).result,
    ).toBe('HOLD_OR_ROLLBACK');
  });
  it('acceptance locks the decision and cannot resume financial or routing actions', () => {
    const accepted = advance(at('ACCEPT'), 'ACCEPT', evidence('ACCEPT'));
    expect(() => rollback(accepted, true)).toThrow('DECISION_LOCKED');
    expect(() => advance(accepted, 'PRECHECK', evidence('PRECHECK'))).toThrow(
      'DECISION_LOCKED',
    );
    expect(() => noteTargetWrites(accepted, 'NONE')).toThrow('DECISION_LOCKED');
  });
  it('dry-run performs no network calls or production actions', () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network permitted'));
    try {
      expect(offlineSimulation(candidate)).toMatchObject({
        result: 'PASS',
        productionContacts: 0,
        productionChanges: 0,
        liveAcceptance: 'NOT_EXECUTED',
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('fixed safe errors do not emit supplied secrets', () => {
    const secret = 'postgresql://user:do-not-print@private.invalid/postgres';
    expect(() =>
      startCutover({ ...fixtureRelease(), targetOrigin: secret }, candidate),
    ).toThrow('ORIGIN_INVALID');
    expect(() =>
      advance(at('PRECHECK'), 'PRECHECK', {
        ...evidence('PRECHECK'),
        id: secret,
      }),
    ).toThrow('EVIDENCE_ID_INVALID');
  });
  it('read-only preflight rejects wrong SHA and has rollback/config/artifact requirements', async () => {
    const result = await preflight('f'.repeat(40));
    expect(result.result).toBe('FAIL');
    expect(result.checks.candidate).toBe(false);
    expect(result.checks['deploy/serverless-cutover/rollback.md']).toBe(true);
    expect(result.checks.phase8).toBe(true);
    expect(result.checks.redisRuntimeBoundary).toBe(true);
    expect(result.checks.configuration).toBe(true);
  });
  it('rollback and runbook forbid automatic split writes and preserve signing authority', async () => {
    const runbook = await readFile(
      join(repositoryRoot, 'deploy/serverless-cutover/rollback.md'),
      'utf8',
    );
    expect(runbook).toContain('RECONCILIATION_REQUIRED');
    expect(runbook).toContain('before resuming writes');
    const ops = await readFile(join(__dirname, 'cli.ts'), 'utf8');
    expect(ops).not.toMatch(
      /sendTransaction|writeContract|privateKeyToAccount|bullmq|ioredis/,
    );
  });
});
