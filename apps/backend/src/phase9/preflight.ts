import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { FALLBACK_SHA, FEATURE_BRANCH, resourceDigest } from './cutover';
import { repositoryRoot } from '../phase7/rehearsal-config';

export const ARTIFACTS = [
  'apps/backend/api/index.cjs',
  'apps/backend/src/serverless.ts',
  'apps/backend/src/deployment/vercel-build.ts',
  'apps/backend/src/phase7/migration-rehearsal.ts',
  'deploy/serverless-data-migration/README.md',
  'deploy/serverless-acceptance/phase8-acceptance.json',
  'deploy/serverless-cutover/README.md',
  'deploy/serverless-cutover/rollback.md',
  'deploy/serverless-cutover/configuration.json',
] as const;
export type Acceptance = {
  baseline_sha: string;
  implementation_acceptance: string;
  features: { result: string }[];
};
export function acceptancePassed(report: Acceptance) {
  return (
    report.baseline_sha === FALLBACK_SHA &&
    report.implementation_acceptance === 'PASS' &&
    report.features.length >= 32 &&
    report.features.every((feature) => feature.result === 'PASS')
  );
}
export async function preflight(expectedSha: string, root = repositoryRoot) {
  // Fixed Git operations only; no shell interpolation, network calls or mutations.
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const checks: Record<string, boolean> = {};
  let candidateSha = '';
  let acceptanceDigest = '';
  try {
    candidateSha = git('rev-parse', 'HEAD');
    checks.candidate =
      /^[a-f0-9]{40}$/.test(expectedSha) && candidateSha === expectedSha;
    checks.branch = git('branch', '--show-current') === FEATURE_BRANCH;
    checks.fallback =
      git('rev-parse', 'vps-production-9900052^{commit}') === FALLBACK_SHA;
    checks.history =
      git('merge-base', '--is-ancestor', FALLBACK_SHA, 'HEAD') === '';
    for (const artifact of ARTIFACTS) {
      checks[artifact] = await access(join(root, artifact)).then(
        () => true,
        () => false,
      );
    }
    const acceptance = await readFile(
      join(root, 'deploy/serverless-acceptance/phase8-acceptance.json'),
      'utf8',
    );
    checks.phase8 = acceptancePassed(JSON.parse(acceptance) as Acceptance);
    acceptanceDigest = createHash('sha256').update(acceptance).digest('hex');
    const isolation = await readFile(
      join(root, 'apps/backend/src/config/runtime-isolation.config.ts'),
      'utf8',
    );
    checks.noGenericFallback = [
      'DATABASE_URL',
      'DIRECT_URL',
      'ARC_MAINNET_DATABASE_URL',
    ].every((name) => isolation.includes(name));
    const composition = await readFile(
      join(root, 'apps/backend/src/app.module.ts'),
      'utf8',
    );
    checks.redisRuntimeBoundary =
      composition.includes("if (mode === 'server')") &&
      composition.includes("import('./queue/queue.module.js')");
    const frontend = await readFile(
      join(root, 'apps/frontend/lib/backend-api.ts'),
      'utf8',
    );
    checks.explicitFrontend =
      frontend.includes('NEXT_PUBLIC_API_URL') &&
      frontend.includes('Legacy frontend backend-URL aliases are not accepted');
    const contract = JSON.parse(
      await readFile(
        join(root, 'deploy/serverless-cutover/configuration.json'),
        'utf8',
      ),
    ) as { variables: { name: string; status: string; category: string }[] };
    checks.configuration =
      contract.variables.length > 20 &&
      contract.variables.every(
        (item) =>
          /^[A-Z][A-Z0-9_]*$/.test(item.name) &&
          ['REQUIRED', 'OPTIONAL', 'DERIVED', 'FORBIDDEN'].includes(
            item.status,
          ),
      );
    const runtime = JSON.parse(
      await readFile(
        join(
          root,
          'apps/backend/.vercel/output/functions/api.func/.vc-config.json',
        ),
        'utf8',
      ),
    ) as { runtime: string; handler: string };
    checks.builtArtifact =
      runtime.runtime === 'nodejs24.x' &&
      runtime.handler === 'apps/backend/api/index.cjs';
    checks.builtRedisFree =
      (await access(
        join(
          root,
          'apps/backend/.vercel/output/functions/api.func/node_modules/bullmq',
        ),
      ).then(
        () => false,
        () => true,
      )) &&
      (await access(
        join(
          root,
          'apps/backend/.vercel/output/functions/api.func/node_modules/ioredis',
        ),
      ).then(
        () => false,
        () => true,
      ));
    checks.mainnetResources = resourceDigest().length === 64;
  } catch {
    checks.inspection = false;
  }
  return {
    version: 1,
    scope: 'OFFLINE_READ_ONLY',
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    candidateSha,
    fallbackSha: FALLBACK_SHA,
    acceptanceDigest,
    resourceDigest: resourceDigest(),
    checks,
    liveCutover: 'NOT_EXECUTED',
  };
}
