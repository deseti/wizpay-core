import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openPostgresHarness } from '../../test/postgres-harness';
import { buildVercelOutput } from './vercel-build';

const describeLocal = process.env.VERCEL_API_TEST_DATABASE_URL
  ? describe
  : describe.skip;

describeLocal('Phase 8 packaged API feature and cold-restart parity', () => {
  it('preserves authenticated requests, payment evidence and durable state across independent processes', async () => {
    const harness = await openPostgresHarness(
      'VERCEL_API_TEST_DATABASE_URL',
      'wizpay_phase6_test_admin',
    );
    const sandbox = await mkdtemp(join(tmpdir(), 'wizpay-phase8-artifact-'));
    // Ephemeral, unfunded test accounts sign authentication messages only.
    // No account/key is supplied to the application or committed to fixtures.
    const wallet = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    try {
      const built = await buildVercelOutput();
      await cp(built.functionRoot, sandbox, { recursive: true });
      const database = await harness.prisma.$queryRaw<{ name: string }[]>`
        SELECT current_database() AS name`;
      const url = new URL(process.env.VERCEL_API_TEST_DATABASE_URL!);
      url.pathname = `/${database[0].name}`;
      const script = await readFile(
        join(__dirname, '../../test/phase8-artifact.cjs'),
        'utf8',
      );
      const run = (state?: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const child = spawn(process.execPath, ['-'], {
            cwd: sandbox,
            env: {
              PATH: process.env.PATH,
              NODE_PATH: '',
              NODE_ENV: 'production',
              WIZPAY_RUNTIME_MODE: 'serverless',
              WIZPAY_ARC_NETWORK: 'arc-mainnet',
              WIZPAY_DATABASE_PROFILE: 'vps', // Isolated PostgreSQL only.
              ARC_MAINNET_DATABASE_URL: url.toString(),
              CORS_ORIGINS: 'https://app.wizpay.xyz',
              ...Object.fromEntries(
                [
                  'SEND',
                  'SAME_TOKEN_PAYROLL',
                  'INVOICE',
                  'PAYMENT_LINK',
                  'SWAP',
                  'BRIDGE',
                  'CROSS_TOKEN_PAYROLL',
                ].map((name) => [
                  `WIZPAY_ARC_MAINNET_CAPABILITY_${name}`,
                  'true',
                ]),
              ),
            },
            stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
          });
          const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
          let result: Record<string, unknown> | undefined;
          let failure = 'child did not finish';
          child.on(
            'message',
            (value: {
              action: string;
              message: string;
              wrong?: boolean;
              state: Record<string, unknown>;
              stage: string;
            }) => {
              if (value.action === 'ready') {
                child.send({
                  address: wallet.address,
                  otherAddress: other.address,
                  state,
                });
              } else if (value.action === 'sign') {
                void (value.wrong ? other : wallet)
                  .signMessage({ message: value.message })
                  .then((signature) => child.send({ signature }));
              } else if (value.action === 'pass') {
                result = value.state;
              } else if (value.action === 'fail') {
                // Stage is a fixed label; never include driver/HTTP response text.
                failure = value.stage;
              }
            },
          );
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && result) resolve(result);
            else reject(new Error(`Phase 8 artifact failed at ${failure}`));
          });
          child.stdin!.end(script);
        });
      const state = await run();
      await run(state);
      expect(
        await harness.prisma.executionIntent.count({
          where: { status: 'COMPLETED' },
        }),
      ).toBe(2);
      expect(
        await harness.prisma.invoicePayment.count({
          where: { status: 'VERIFIED' },
        }),
      ).toBe(1);
      expect(await harness.prisma.invoice.count()).toBe(2);
      expect(
        await harness.prisma.activityAuthSession.count({
          where: { revokedAt: { not: null } },
        }),
      ).toBe(1);
    } finally {
      await harness.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 120_000);
});
