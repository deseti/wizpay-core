import { readFile } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import {
  evaluateDecommission,
  routingIndependent,
  type DecommissionEvidence,
} from './decommission';
import { repositoryPreflight } from './repository';
import { simulateDecommission } from './fixtures';
import { collectDns } from './dns';
import { validateRelease } from '../phase9/cutover';

const blocked = () => ({
  scope: 'PREPARATION_ONLY',
  decommission: 'BLOCKED',
  subscriptionCancellation: 'BLOCKED',
  reasons: ['LIVE_EVIDENCE_REQUIRED'],
  actionsExecuted: 0,
});
async function main() {
  const [command = '--check', file] = process.argv.slice(2);
  if (command === '--simulate') return simulateDecommission();
  const candidate = process.env.WIZPAY_DECOMMISSION_CANDIDATE_SHA ?? '';
  if (command === '--repository-preflight')
    return repositoryPreflight(candidate);
  if (command === '--check' && !file) return blocked();
  if (!['--check', '--dns-check'].includes(command) || !file)
    throw new Error('COMMAND_INVALID');
  const input: unknown = JSON.parse(await readFile(file, 'utf8'));
  const evidence = input as DecommissionEvidence;
  if (command === '--dns-check') {
    if (process.env.WIZPAY_DECOMMISSION_READONLY_ACK !== 'PINNED_READONLY_DNS')
      throw new Error('DNS_ACK_REQUIRED');
    validateRelease(
      evidence.release,
      process.env.WIZPAY_DECOMMISSION_RELEASE_SHA ?? '',
    );
    const resolver = new Resolver({ timeout: 1000, tries: 1 });
    const names = [
      'app.wizpay.xyz',
      new URL(evidence.release.targetOrigin).hostname,
      ...evidence.routing.requiredNames,
    ];
    try {
      const collected = await collectDns(names, (name, type) =>
        type === 'A'
          ? resolver.resolve4(name)
          : type === 'AAAA'
            ? resolver.resolve6(name)
            : resolver.resolveCname(name),
      );
      const independent = routingIndependent(
        { ...evidence.routing, ...collected },
        evidence.release,
      );
      return {
        scope: 'LIVE_READ_ONLY_DNS',
        result: independent ? 'PASS' : 'FAIL',
        namesChecked: collected.namesChecked,
        actionsExecuted: 0,
      };
    } finally {
      resolver.cancel();
    }
  }
  const expectedRelease = process.env.WIZPAY_DECOMMISSION_RELEASE_SHA ?? '';
  const result = evaluateDecommission(evidence, expectedRelease);
  if (result.decommission === 'BLOCKED') return result;
  // Operator receipts must agree with current repository/recovery identity.
  const repo = await repositoryPreflight(candidate);
  if (
    repo.result !== 'PASS' ||
    repo.acceptanceDigest !== evidence.release.acceptanceDigest
  )
    return {
      ...result,
      decommission: 'BLOCKED',
      subscriptionCancellation: 'BLOCKED',
      blocked: ['REPOSITORY_OR_ACCEPTANCE_NOT_VERIFIED'],
    };
  return result;
}
if (require.main === module) {
  void main().then(
    (result) => {
      console.log(JSON.stringify(result));
      if (
        ('decommission' in result && result.decommission === 'BLOCKED') ||
        ('result' in result && result.result !== 'PASS')
      )
        process.exitCode = 1;
    },
    () => {
      console.error(
        JSON.stringify({
          decommission: 'BLOCKED',
          subscriptionCancellation: 'BLOCKED',
          reason: 'INPUT_OR_CHECK_INVALID',
          actionsExecuted: 0,
        }),
      );
      process.exitCode = 1;
    },
  );
}
