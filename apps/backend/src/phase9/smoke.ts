import { randomBytes } from 'node:crypto';
import {
  publicOrigin,
  resourceDigest,
  verifyTarget,
  type Release,
  type TargetMetadata,
} from './cutover';
import {
  ARC_MAINNET_UNISWAP_V4_USDC,
  ARC_MAINNET_UNISWAP_V4_EURC,
} from '../user-swap/mainnet-uniswap-v4-protocol';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type SmokeInput = {
  release: Release;
  metadata: TargetMetadata; // Secure provider-side env/deployment attestation, not inferred from /health.
  checkoutId?: string; // Operator's designated public fixture; never a private invoice record.
  session?: string; // Memory only; never in reports, files or command arguments.
  writeNonce?: boolean;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const SMOKE_PLAN = [
  'health-cors',
  'runtime-database',
  'capabilities',
  'authorization',
  'arc-uniswap-readiness',
  'uniswap-quote',
  'circle-quote',
  'public-checkout',
  'wallet-challenge',
  'activity-read',
] as const;
export async function runSmoke(input: SmokeInput, request: Fetch) {
  let stage: string = 'metadata';
  let targetWritesPossible = false;
  let nonceProbeAttempted = false;
  const results: { check: string; result: string; status?: number }[] = [];
  function requireCheck(value: unknown) {
    if (!value) throw new Error('SMOKE_FAILED');
  }
  try {
    verifyTarget(input.metadata, input.release);
    const origin = publicOrigin(input.release.targetOrigin);
    requireCheck(new URL(origin).hostname.endsWith('.vercel.app'));
    async function get(path: string, init?: RequestInit) {
      const response = await request(origin + path, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      return { response, body: object(await response.json()) };
    }
    function pass(status: number) {
      results.push({ check: stage, result: 'PASS', status });
    }
    stage = 'health-cors';
    const health = await get('/health', {
      headers: { Origin: 'https://app.wizpay.xyz' },
    });
    requireCheck(
      health.response.status === 200 &&
        health.body.status === 'ok' &&
        health.response.headers.get('access-control-allow-origin') ===
          'https://app.wizpay.xyz',
    );
    pass(200);
    const denied = await get('/health', {
      headers: { Origin: 'https://untrusted.invalid' },
    });
    requireCheck(!denied.response.headers.get('access-control-allow-origin'));
    stage = 'runtime-database';
    const runtime = await get('/health/runtime-isolation');
    const db = object(runtime.body.database);
    requireCheck(
      runtime.response.status === 200 &&
        runtime.body.network === 'arc-mainnet' &&
        runtime.body.environment === 'mainnet' &&
        !('redis' in runtime.body) &&
        !('queuePrefix' in runtime.body) &&
        db.host === 'aws-0-ap-southeast-1.pooler.supabase.com' &&
        db.port === 6543 &&
        db.database === 'postgres' &&
        input.metadata.resourceDigest === resourceDigest(),
    );
    pass(200);
    stage = 'capabilities';
    const capability = await get('/capabilities');
    const data = object(capability.body.data),
      flags = object(data.capabilities);
    requireCheck(
      capability.response.status === 200 &&
        data.network === 'arc-mainnet' &&
        [
          'send',
          'sameTokenPayroll',
          'invoice',
          'paymentLink',
          'swap',
          'bridge',
          'crossTokenPayroll',
        ].every(
          (key) =>
            typeof flags[key] === 'boolean' &&
            flags[key] === input.release.approvedCapabilities[key],
        ),
    );
    requireCheck(
      ['liquidity', 'crossTokenInvoice', 'nanoAgentApi'].every(
        (key) => flags[key] === false,
      ),
    );
    pass(200);
    stage = 'authorization';
    requireCheck((await get('/activities')).response.status === 401);
    pass(401);
    stage = 'arc-uniswap-readiness';
    const ready = await get('/user-swap/mainnet/readiness');
    const readiness = object(ready.body.data);
    // Existing readiness verifier reads Arc RPC + exact pool identity; available=false is a failure.
    requireCheck(
      ready.response.status === 200 &&
        readiness.available === true &&
        readiness.poolIdentityStatus === 'verified-live',
    );
    pass(200);
    if (flags.swap === true || flags.crossTokenPayroll === true) {
      stage = 'uniswap-quote';
      const quote = await get('/user-swap/mainnet/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: 5042,
          tokenInAddress: ARC_MAINNET_UNISWAP_V4_USDC,
          tokenOutAddress: ARC_MAINNET_UNISWAP_V4_EURC,
          amountIn: '1000000',
          recipient: '0x1000000000000000000000000000000000000001',
          walletAddress: '0x1000000000000000000000000000000000000001',
          walletControl: 'external-wallet',
          slippageBps: 100,
          deadline: Math.floor(Date.now() / 1000) + 300,
        }),
      });
      requireCheck(
        quote.response.status === 201 &&
          Object.keys(object(quote.body.data)).length > 0,
      );
      pass(201);
    }
    if (flags.bridge === true) {
      stage = 'circle-quote';
      const quote = await get(
        '/bridge/quote?sourceCode=BASE-MAINNET&destinationCode=ARC-MAINNET&amount=1000000',
      );
      requireCheck(
        quote.response.status === 200 &&
          object(quote.body.data).sourceCode === 'BASE-MAINNET',
      );
      pass(200);
    }
    stage = 'public-checkout';
    if (input.checkoutId) {
      requireCheck(/^[a-zA-Z0-9_-]{22}$/.test(input.checkoutId));
      targetWritesPossible = true; // Public GET may expire an eligible invoice.
      const checkout = await get(`/public/invoices/${input.checkoutId}`);
      requireCheck(
        checkout.response.status === 200 &&
          object(checkout.body.data).publicId === input.checkoutId,
      );
      pass(200);
    } else results.push({ check: stage, result: 'MISSING_FIXTURE' });
    stage = 'wallet-challenge';
    if (input.writeNonce) {
      targetWritesPossible = true;
      nonceProbeAttempted = true;
      const challenge = await get('/wallets/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: `0x${randomBytes(20).toString('hex')}`,
          chainId: 5042,
        }),
      });
      const nonce = object(challenge.body.data);
      requireCheck(
        challenge.response.status === 201 &&
          typeof nonce.challengeId === 'string' &&
          nonce.chainId === 5042,
      );
      pass(201);
    } else results.push({ check: stage, result: 'NOT_EXECUTED' });
    stage = 'activity-read';
    if (input.session) {
      targetWritesPossible = true; // Existing auth may update lastUsedAt.
      const activity = await get('/activities', {
        headers: { Authorization: `Bearer ${input.session}` },
      });
      requireCheck(activity.response.status === 200 && activity.body.data);
      pass(200);
    } else results.push({ check: stage, result: 'MISSING_SESSION' });
    // Partial checks must never be sufficient evidence for a production switch.
    return {
      result: results.every((item) => item.result === 'PASS')
        ? 'PASS'
        : 'INCOMPLETE',
      checks: results,
      targetWritesPossible,
      nonceProbeAttempted,
      financialExecution: false,
    };
  } catch {
    return {
      result: 'FAIL',
      checks: [...results, { check: stage, result: 'FAIL' }],
      targetWritesPossible,
      nonceProbeAttempted,
      financialExecution: false,
    };
  }
}
