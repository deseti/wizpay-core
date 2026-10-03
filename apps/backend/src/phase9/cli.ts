import { readFile } from 'node:fs/promises';
import {
  advance,
  CHECKS,
  FALLBACK_SHA,
  STAGES,
  resourceDigest,
  startCutover,
  summarizeObservation,
  type Evidence,
  type Observation,
  type Release,
} from './cutover';
import { preflight } from './preflight';
import { runSmoke, SMOKE_PLAN, type SmokeInput } from './smoke';

export function offlineSimulation(candidateSha: string) {
  const release: Release = {
    approvedCapabilities: {
      send: true,
      sameTokenPayroll: true,
      invoice: true,
      paymentLink: true,
      swap: true,
      bridge: true,
      crossTokenPayroll: true,
    },
    candidateSha,
    fallbackSha: FALLBACK_SHA,
    resourceDigest: resourceDigest(),
    acceptanceDigest: 'a'.repeat(64),
    targetProject: 'tsvzblikmgocgksgxguc',
    targetOrigin: 'https://wizpay-offline-fixture.vercel.app',
    fallbackOrigin: 'https://vps.offline.invalid',
    deploymentId: 'offline_fixture',
    migrationEvidenceId: 'offline_fixture',
    startedAt: null,
  };
  let state = startCutover(release, candidateSha);
  for (const stage of STAGES) {
    state = advance(state, stage, {
      id: `fixture_${stage}`,
      candidateSha,
      scope: 'OFFLINE',
      checks: Object.fromEntries(CHECKS[stage].map((key) => [key, true])),
    });
  }
  return {
    scope: 'OFFLINE_SYNTHETIC',
    result: 'PASS',
    stages: state.stages,
    decision: state.decision,
    productionContacts: 0,
    productionChanges: 0,
    liveAcceptance: 'NOT_EXECUTED',
  };
}

async function main() {
  const [command = '--plan', file] = process.argv.slice(2);
  const candidate = process.env.WIZPAY_CUTOVER_CANDIDATE_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error('CANDIDATE_REQUIRED');
  if (command === '--plan')
    return {
      scope: 'PREPARATION_ONLY',
      candidateSha: candidate,
      fallbackSha: FALLBACK_SHA,
      stages: STAGES,
      smoke: SMOKE_PLAN,
      productionChanges: 0,
      liveAcceptance: 'DEFERRED',
    };
  if (command === '--preflight') return preflight(candidate);
  if (command === '--simulate') return offlineSimulation(candidate);
  if (!file) throw new Error('EVIDENCE_FILE_REQUIRED');
  const input: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (command === '--observation')
    return summarizeObservation(input as Observation);
  if (command === '--replay') {
    // Validate a chronological evidence ledger; replay cannot execute its actions.
    const checked = await preflight(candidate);
    if (checked.result !== 'PASS') throw new Error('PREFLIGHT_FAILED');
    const ledger = input as {
      release: Release;
      scope: 'OFFLINE' | 'LIVE';
      evidence: Evidence[];
    };
    if (ledger.release.acceptanceDigest !== checked.acceptanceDigest)
      throw new Error('ACCEPTANCE_DIGEST_MISMATCH');
    let state = startCutover(ledger.release, candidate, ledger.scope);
    for (const evidence of ledger.evidence) {
      state = advance(state, STAGES[state.stages.length], evidence);
    }
    return {
      scope: state.scope,
      candidateSha: state.release.candidateSha,
      stages: state.stages,
      decision: state.decision,
      authorityRecord: state.authority,
      targetWrites: state.targetWrites,
      actionsExecuted: 0,
    };
  }
  if (command === '--target-smoke' || command === '--production-smoke') {
    if (
      process.env.WIZPAY_CUTOVER_LIVE_SMOKE_ACK !==
      'NON_FINANCIAL_PINNED_TARGET'
    )
      throw new Error('LIVE_SMOKE_ACK_REQUIRED');
    const checked = await preflight(candidate);
    if (checked.result !== 'PASS') throw new Error('PREFLIGHT_FAILED');
    const smoke = input as SmokeInput;
    if (smoke.release.acceptanceDigest !== checked.acceptanceDigest)
      throw new Error('ACCEPTANCE_DIGEST_MISMATCH');
    startCutover(smoke.release, candidate, 'LIVE');
    // A session is accepted in process memory only, never JSON reports/files/args.
    if ('session' in smoke) throw new Error('SESSION_FILE_FORBIDDEN');
    smoke.session = process.env.WIZPAY_CUTOVER_SMOKE_SESSION;
    smoke.writeNonce =
      process.env.WIZPAY_CUTOVER_NONCE_ACK === 'NON_FINANCIAL_TARGET_WRITE';
    return runSmoke(smoke, (url, init) => fetch(url, init));
  }
  throw new Error('COMMAND_INVALID');
}
if (require.main === module) {
  void main().then(
    (result) => {
      console.log(JSON.stringify(result));
      if ('result' in result && result.result !== 'PASS') process.exitCode = 1;
    },
    () => {
      console.error(
        JSON.stringify({
          result: 'FAIL',
          code: 'CUTOVER_INPUT_OR_GATE_INVALID',
          productionActionsExecuted: 0,
        }),
      );
      process.exitCode = 1;
    },
  );
}
