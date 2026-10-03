import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPostgresHarness } from '../../test/postgres-harness';
import { buildVercelOutput } from './vercel-build';

const describeLocal = process.env.VERCEL_API_TEST_DATABASE_URL
  ? describe
  : describe.skip;

describeLocal('isolated Vercel function artifact with PostgreSQL', () => {
  it('boots without Redis, preserves HTTP behavior and uses one Prisma lifecycle for HTTP and reconciliation', async () => {
    const harness = await openPostgresHarness(
      'VERCEL_API_TEST_DATABASE_URL',
      'wizpay_phase6_test_admin',
    );
    const sandbox = await mkdtemp(join(tmpdir(), 'wizpay-vercel-bundle-'));
    try {
      const built = await buildVercelOutput();
      expect(built.bytes).toBeLessThan(250 * 1024 * 1024);
      expect(
        built.files.some((file) => /(?:bullmq|ioredis|\.env)/.test(file)),
      ).toBe(false);
      const output = JSON.parse(
        await readFile(join(built.output, 'config.json'), 'utf8'),
      ) as { version: number; routes: { src: string; dest: string }[] };
      expect(output).toEqual({
        version: 3,
        routes: [{ src: '/(.*)', dest: '/api' }],
      });
      const runtime = JSON.parse(
        await readFile(join(built.functionRoot, '.vc-config.json'), 'utf8'),
      ) as { runtime: string; handler: string; shouldAddHelpers: boolean };
      expect(runtime).toMatchObject({
        runtime: 'nodejs24.x',
        handler: 'apps/backend/api/index.cjs',
        shouldAddHelpers: false,
      });
      await cp(built.functionRoot, sandbox, {
        recursive: true,
        dereference: false,
      });
      const database = await harness.prisma.$queryRaw<
        { name: string }[]
      >`SELECT current_database() AS name`;
      const url = new URL(process.env.VERCEL_API_TEST_DATABASE_URL!);
      url.pathname = `/${database[0].name}`;
      // Child cwd/node_modules live outside the checkout: missing trace assets
      // cannot be supplied accidentally by development dependencies.
      const child = spawn(process.execPath, ['-'], {
        cwd: sandbox,
        env: {
          PATH: process.env.PATH,
          NODE_PATH: '',
          NODE_ENV: 'production',
          WIZPAY_RUNTIME_MODE: 'serverless',
          WIZPAY_ARC_NETWORK: 'arc-mainnet',
          WIZPAY_DATABASE_PROFILE: 'vps',
          ARC_MAINNET_DATABASE_URL: url.toString(),
          CORS_ORIGINS: 'https://app.wizpay.xyz',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const script = `
        const assert = require('node:assert/strict');
        const { createServer } = require('node:http');
        const Module = require('node:module');
        const originalLoad = Module._load;
        Module._load = function(name, ...args) {
          if (name === 'bullmq' || name === 'ioredis') throw new Error('Legacy transport requested');
          return originalLoad.call(this, name, ...args);
        };
        const { PrismaService } = require('./apps/backend/dist/database/prisma.service.js');
        let initialized = 0;
        const originalInit = PrismaService.prototype.onModuleInit;
        PrismaService.prototype.onModuleInit = async function() { initialized++; return originalInit.call(this); };
        const handler = require('./apps/backend/api/index.cjs');
        const { getServerlessApplication } = require('./apps/backend/dist/serverless.js');
        const { ReconciliationService } = require('./apps/backend/dist/reconciliation/reconciliation.service.js');
        const { runReconciliationBatch } = require('./apps/backend/dist/reconciliation.js');
        const server = createServer(handler); // Test harness only; the function never listens.
        let stage = 'startup';
        (async () => {
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          const origin = 'http://127.0.0.1:' + server.address().port;
          stage = 'concurrent health';
          const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(origin + '/health', { headers: { Origin: 'https://app.wizpay.xyz' } })));
          for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' }); assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.wizpay.xyz'); }
          stage = 'capabilities';
          const capability = await fetch(origin + '/capabilities');
          assert.equal(capability.status, 200); assert.equal((await capability.json()).data.network, 'arc-mainnet');
          stage = 'database request';
          const challenge = await fetch(origin + '/wallets/auth/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: '0x1000000000000000000000000000000000000001', chainId: 5042 }) });
          assert.equal(challenge.status, 201); assert.equal(typeof (await challenge.json()).data.challengeId, 'string');
          stage = 'authorization';
          assert.equal((await fetch(origin + '/activities')).status, 401);
          assert.equal((await fetch(origin + '/health', { headers: { Origin: 'https://untrusted.example' } })).headers.get('access-control-allow-origin'), null);
          stage = 'shared reconciliation';
          const app = await getServerlessApplication();
          const service = app.get(ReconciliationService);
          assert.ok(service); assert.equal((await runReconciliationBatch({ limit: 1 })).claimed, 0);
          assert.equal(initialized, 1); assert.equal(app.getHttpServer().listening, false);
          await new Promise(resolve => server.close(resolve)); await app.close();
          console.log('WIZPAY_BUNDLE_PASS');
        })().catch(async () => { console.error('Bundle smoke failure stage: ' + stage); server.close(); const app = await getServerlessApplication().catch(e => { const message = e.message || ''; const allowed = message.startsWith('Nest can') || message.startsWith('Cannot find module') || message.startsWith('Module not found') || message.startsWith('Legacy transport requested'); console.error('BUNDLE_SAFE_ERROR:' + e.name + ':' + (e.code || 'none') + ':' + (allowed ? message.slice(0, 200) : 'redacted')); return null; }); if (app) await app.close(); process.exitCode = 1; });
      `;
      child.stdin.end(script);
      let outputText = '';
      child.stdout.on('data', (value: Buffer) => {
        outputText += value.toString();
      });
      let errorText = '';
      child.stderr.on('data', (value: Buffer) => {
        errorText += value.toString();
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
      try {
        const result = await new Promise<number | null>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        if (result !== 0) {
          const stage =
            errorText.match(/Bundle smoke failure stage: ([a-z ]+)/)?.[1] ??
            'module initialization';
          const detail =
            errorText.match(/BUNDLE_SAFE_ERROR:([^\n]+)/)?.[1] ?? 'none';
          const missing =
            errorText.match(/Cannot find module '([a-zA-Z0-9_@/.-]+)'/)?.[1] ??
            'none';
          throw new Error(
            `Isolated bundle failed at ${stage}; missing module: ${missing}; error: ${detail}`,
          );
        }
        expect(outputText).toContain('WIZPAY_BUNDLE_PASS');
        expect(await harness.prisma.walletAuthChallenge.count()).toBe(1);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await harness.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});
