import { excludedDeploymentFile } from './vercel-build';

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
