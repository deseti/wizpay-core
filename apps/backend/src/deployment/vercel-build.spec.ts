import {
  buildVercelOutput,
  excludedDeploymentFile,
  SUPABASE_CA_ASSET,
} from './vercel-build';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import nft = require('@vercel/nft');

describe('Vercel deployment file boundary', () => {
  it('excludes credentials, deployment metadata and legacy Redis runtime files', () => {
    for (const file of [
      '.env',
      'apps/backend/.env.production',
      '.vercel/project.json',
      'apps/backend/dist/queue/queue.module.js',
      'apps/backend/dist/orchestrator/orchestrator.module.js',
      'node_modules/bullmq/dist/index.js',
      'node_modules/ioredis/built/index.js',
    ])
      expect(excludedDeploymentFile(file)).toBe(true);
    for (const file of [
      'apps/backend/api/index.cjs',
      'apps/backend/dist/serverless.js',
      'apps/backend/dist/orchestrator/payroll-init.service.js',
      'apps/backend/dist/orchestrator/task.controller.js',
      'apps/backend/dist/reconciliation.js',
      'node_modules/.prisma/client/default.js',
      'packages/arc-network/index.js',
    ])
      expect(excludedDeploymentFile(file)).toBe(false);
  });
});

describe('required Vercel CA asset', () => {
  it('copies and verifies the CA even when it is absent from the trace, and rejects a missing source', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'wizpay-package-'));
    const backend = join(repository, 'apps/backend');
    const files = [
      'apps/backend/api/index.cjs',
      'apps/backend/dist/reconciliation.js',
      'apps/backend/dist/serverless.js',
      'node_modules/.prisma/client/default.js',
    ];
    const trace = jest.spyOn(nft, 'nodeFileTrace').mockResolvedValue({
      fileList: new Set(files),
      warnings: new Set(),
    } as Awaited<ReturnType<typeof nft.nodeFileTrace>>);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const path of [
        ...files,
        'apps/backend/package.json',
        SUPABASE_CA_ASSET,
      ]) {
        await mkdir(dirname(join(repository, path)), { recursive: true });
        await writeFile(
          join(repository, path),
          path.endsWith('package.json') ? '{"name":"backend"}' : 'fixture',
        );
      }
      const result = await buildVercelOutput(backend);
      expect(result.files).toContain(SUPABASE_CA_ASSET);
      expect(
        await readFile(join(result.functionRoot, SUPABASE_CA_ASSET), 'utf8'),
      ).toBe('fixture');
      await rm(join(repository, SUPABASE_CA_ASSET));
      await expect(buildVercelOutput(backend)).rejects.toThrow();
    } finally {
      trace.mockRestore();
      log.mockRestore();
      await rm(repository, { recursive: true, force: true });
    }
  });
});
