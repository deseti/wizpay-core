import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Arc Mainnet deployment isolation files', () => {
  const mainnet = read('deploy/arc-mainnet/compose.yml');
  const mainnetTemplate = read('deploy/arc-mainnet/environment.template');
  const workflow = read('.github/workflows/cd-production.yml');
  const packageJson = read('apps/backend/package.json');
  const prismaConfig = read('apps/backend/prisma.config.ts');

  it('uses distinct Mainnet project, network, PostgreSQL, and Redis volume identities', () => {
    for (const identity of [
      'wizpay-arc-mainnet',
      'wizpay-arc-mainnet-postgres',
      'wizpay-arc-mainnet-redis',
    ]) {
      expect(mainnet).toContain(identity);
    }
    expect(mainnet).not.toContain('container_name:');
  });

  it('scopes Mainnet runtime configuration to Mainnet variables only', () => {
    expect(mainnet).toContain('WIZPAY_ARC_NETWORK: arc-mainnet');
    expect(mainnet).toContain('ARC_MAINNET_DATABASE_URL');
    expect(mainnet).toContain('ARC_MAINNET_REDIS_URL');
    expect(mainnet).toContain('ARC_MAINNET_QUEUE_PREFIX');
    expect(mainnet).not.toMatch(/testnet/i);
  });

  it('keeps the Mainnet deployment external-wallet-only', () => {
    expect(mainnet).not.toMatch(/circle_/i);
    expect(mainnetTemplate).toContain('WIZPAY_ARC_NETWORK=arc-mainnet');
    expect(mainnetTemplate).toContain(
      'NEXT_PUBLIC_WIZPAY_ARC_NETWORK=arc-mainnet',
    );
    expect(mainnetTemplate).toContain('external-wallet-only');
    expect(mainnetTemplate).toContain('ARC_MAINNET_QUEUE_PREFIX');
  });

  it('uses a backend-only VPS topology with health and restart controls', () => {
    expect(mainnet).not.toMatch(/^\s{2}frontend:/m);
    expect(mainnet).not.toMatch(/^\s{2}nginx:/m);
    expect(mainnet).toContain(
      '127.0.0.1:${WIZPAY_BACKEND_HOST_PORT:-4100}:4000',
    );
    expect(mainnet.match(/restart: unless-stopped/g)).toHaveLength(3);
    expect(mainnet.match(/healthcheck:/g)).toHaveLength(3);
    expect(mainnet).toContain(
      'entrypoint: ["npm", "run", "prisma:migrate:arc-mainnet"]',
    );
    expect(mainnet).not.toMatch(/^\s+ports:.*postgres|^\s+ports:.*redis/m);
  });

  it('wires every supported destination receipt RPC without embedding a provider', () => {
    for (const chainId of [1, 10, 137, 8453, 42161, 43114]) {
      expect(mainnet).toContain(`BRIDGE_DESTINATION_RPC_${chainId}`);
      expect(mainnetTemplate).toContain(`BRIDGE_DESTINATION_RPC_${chainId}`);
    }
    expect(mainnet).not.toMatch(/alchemy|infura|quicknode/i);
  });

  it('locks production origin and Vercel variables without legacy public aliases', () => {
    expect(mainnetTemplate).toContain('CORS_ORIGINS=https://app.wizpay.xyz');
    expect(mainnetTemplate).toContain(
      'NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL=https://app.wizpay.xyz',
    );
    expect(mainnetTemplate).toContain('NEXT_PUBLIC_API_URL=');
    expect(mainnetTemplate).toContain('NEXT_PUBLIC_REOWN_PROJECT_ID=');
    expect(mainnetTemplate).not.toMatch(
      /NEXT_PUBLIC_(?:BACKEND_API_BASE_URL|BACKEND_URL|CIRCLE|TESTNET|W3S|XYLO|STABLE)/i,
    );
  });

  it('keeps the future CD path backend-only and explicitly confirmed', () => {
    expect(workflow).toContain('ARC_MAINNET_BACKEND_ONLY');
    expect(workflow).toContain('-f deploy/arc-mainnet/compose.yml');
    expect(workflow).toContain('--profile migration run --rm migrate');
    expect(workflow).not.toMatch(
      /build frontend|up -d .*frontend|wizpay-frontend/i,
    );
  });

  it('keeps the Mainnet manifest empty of addresses and receipts', () => {
    const manifest: unknown = JSON.parse(
      read('packages/contracts/deployments/arc-mainnet-wizpay-v2.json'),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      network: 'arc-mainnet',
      chainId: 5042,
      status: 'unavailable',
      contract: 'WizPayMainnetV2',
      resourceManifestDigest: null,
      deploymentPlanDigest: null,
      deploymentResult: {
        transactionHash: null,
        blockNumber: null,
        deployedAddress: null,
        runtimeBytecodeHash: null,
        verificationStatus: 'unavailable',
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it('requires an explicit matching Mainnet network for migration commands', () => {
    expect(packageJson).toContain('prisma:migrate:arc-mainnet');
    expect(prismaConfig).toContain('ARC_MAINNET_DATABASE_URL');
    expect(prismaConfig).not.toMatch(/testnet/i);
    expect(prismaConfig).toContain('migrationNetwork !== selectedNetwork');
    expect(prismaConfig).toContain('process.env.DATABASE_URL !== undefined');
  });
});
