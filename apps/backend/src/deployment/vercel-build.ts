import { nodeFileTrace } from '@vercel/nft';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const ENTRY = 'apps/backend/api/index.cjs';
const RECOVERY = 'apps/backend/dist/reconciliation.js';
const EXCLUDED = [
  'apps/backend/dist/queue/**',
  'apps/backend/dist/orchestrator/orchestrator.module.js',
  'apps/backend/dist/orchestrator/orchestrator.service.js',
  'node_modules/bullmq/**',
  'node_modules/ioredis/**',
];

export function excludedDeploymentFile(path: string) {
  return (
    path
      .split('/')
      .some(
        (part) =>
          part === '.git' || part === '.vercel' || /^\.env(?:\.|$)/.test(part),
      ) ||
    (/(?:^|\/)queue\//.test(path) && path.startsWith('apps/backend/dist/')) ||
    /^apps\/backend\/dist\/orchestrator\/orchestrator\.(?:module|service)\.js$/.test(
      path,
    ) ||
    /^node_modules\/(?:bullmq|ioredis)(?:\/|$)/.test(path)
  );
}

/** Build Output API v3 preserves tsc/Nest decorator metadata and workspace paths. */
export async function buildVercelOutput(
  backendRoot = resolve(__dirname, '../..'),
) {
  const repository = resolve(backendRoot, '../..');
  const manifest = JSON.parse(
    await readFile(join(backendRoot, 'package.json'), 'utf8'),
  ) as { name: string };
  if (
    manifest.name !== 'backend' ||
    relative(repository, backendRoot) !== 'apps/backend'
  )
    throw new Error('Vercel packaging requires the backend workspace.');
  const output = join(backendRoot, '.vercel/output');
  const functionRoot = join(output, 'functions/api.func');
  const traced = await nodeFileTrace(
    [join(repository, ENTRY), join(repository, RECOVERY)],
    {
      base: repository,
      processCwd: backendRoot,
      ignore: EXCLUDED,
    },
  );
  const files = [...traced.fileList]
    .filter((path) => !excludedDeploymentFile(path))
    .sort();
  for (const required of [
    ENTRY,
    RECOVERY,
    'apps/backend/dist/serverless.js',
    'node_modules/.prisma/client/default.js',
  ])
    if (!files.includes(required))
      throw new Error(`Required deployment asset was not traced: ${required}`);
  // Tracing warning messages can include machine paths. Publish counts only;
  // isolated bundle tests verify the actual runtime rather than suppressing failures.
  await rm(output, { recursive: true, force: true });
  await mkdir(functionRoot, { recursive: true });
  let bytes = 0;
  for (const path of files) {
    if (isAbsolute(path) || path.startsWith('../'))
      throw new Error('Deployment asset escaped the repository.');
    const source = join(repository, path);
    const destination = join(functionRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) {
      const link = await readlink(source);
      if (
        isAbsolute(link) ||
        relative(repository, resolve(dirname(source), link)).startsWith('../')
      )
        throw new Error('Deployment symlink escaped the repository.');
      await symlink(link, destination);
    } else {
      if (!stat.isFile())
        throw new Error('Unexpected non-file deployment asset.');
      bytes += stat.size;
      await copyFile(source, destination);
    }
  }
  if (bytes >= 250 * 1024 * 1024)
    throw new Error('Vercel function exceeds the uncompressed size limit.');
  await writeFile(
    join(functionRoot, '.vc-config.json'),
    JSON.stringify(
      {
        runtime: 'nodejs24.x',
        handler: ENTRY,
        launcherType: 'Nodejs',
        shouldAddHelpers: false,
        maxDuration: 60,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(output, 'config.json'),
    JSON.stringify(
      {
        version: 3,
        routes: [{ src: '/(.*)', dest: '/api' }],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      stage: 'vercel-package',
      files: files.length,
      bytes,
      traceWarnings: traced.warnings.size,
      runtime: 'nodejs24.x',
    }),
  );
  return { output, functionRoot, files, bytes };
}

if (require.main === module) {
  void buildVercelOutput().catch(() => {
    console.error(
      'Vercel packaging failed. Check generated assets and workspace resolution.',
    );
    process.exitCode = 1;
  });
}
