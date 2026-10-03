import { execFileSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveVerified } from './decommission';
import { preflight } from '../phase9/preflight';
import { repositoryRoot } from '../phase7/rehearsal-config';
export const RECOVERY_REFS = [
  'refs/heads/archive/vps-production',
  'refs/tags/vps-production-9900052',
  'refs/tags/vps-production-9900052^{}',
];
export function parseRecoveryRefs(output: string) {
  const refs = new Map<string, string>();
  for (const line of output.trim().split('\n')) {
    const [sha, ref] = line.split(/\s+/);
    if (/^[a-f0-9]{40}$/.test(sha) && RECOVERY_REFS.includes(ref))
      refs.set(ref, sha);
  }
  const archive = {
    branchSha: refs.get(RECOVERY_REFS[0]) ?? '',
    tagObject: refs.get(RECOVERY_REFS[1]) ?? '',
    tagSha: refs.get(RECOVERY_REFS[2]) ?? '',
  };
  return { result: archiveVerified(archive) ? 'PASS' : 'FAIL', archive };
}
export function remoteRecoveryRefs(root = repositoryRoot) {
  try {
    return parseRecoveryRefs(
      execFileSync('git', ['ls-remote', 'origin', ...RECOVERY_REFS], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return { result: 'FAIL', archive: null };
  }
}
export async function repositoryPreflight(expectedSha: string) {
  const phase9 = await preflight(expectedSha);
  const recovery = remoteRecoveryRefs();
  const required = [
    'README.md',
    'recovery.md',
    'checklist.md',
    'dependency-inventory.json',
    'environment-recovery.json',
  ];
  const documents = await Promise.all(
    required.map((name) =>
      access(join(repositoryRoot, 'deploy/serverless-decommission', name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  const inventory = JSON.parse(
    await readFile(
      join(
        repositoryRoot,
        'deploy/serverless-decommission/dependency-inventory.json',
      ),
      'utf8',
    ),
  ) as {
    dependencies: { id: string; classification: string; sources: string[] }[];
  };
  const inventoryValid =
    inventory.dependencies.length >= 18 &&
    inventory.dependencies.every(
      (item) =>
        /^[a-z0-9-]+$/.test(item.id) &&
        [
          'REMOVED',
          'REPLACED',
          'MUST_VERIFY_LIVE',
          'HISTORICAL_ONLY',
          'BLOCKS_DECOMMISSION',
        ].includes(item.classification) &&
        item.sources.length > 0,
    );
  return {
    scope: 'REPOSITORY_READ_ONLY',
    result:
      phase9.result === 'PASS' &&
      recovery.result === 'PASS' &&
      documents.every(Boolean) &&
      inventoryValid
        ? 'PASS'
        : 'FAIL',
    candidateSha: phase9.candidateSha,
    archive: recovery.archive,
    acceptanceDigest: phase9.acceptanceDigest,
    dependencies: inventory.dependencies.length,
    documentsPresent: documents.every(Boolean),
    liveDecommission: 'BLOCKED_PENDING_LIVE_EVIDENCE',
    actionsExecuted: 0,
  };
}
