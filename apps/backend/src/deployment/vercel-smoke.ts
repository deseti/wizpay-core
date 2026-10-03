import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  ARC_MAINNET_UNISWAP_V4_USDC,
  ARC_MAINNET_UNISWAP_V4_EURC,
} from '../user-swap/mainnet-uniswap-v4-protocol';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function validationOrigin(value: string) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && url.hostname.endsWith('.vercel.app'));
  assert(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
  );
  return url.origin;
}

/** Non-financial deployed smoke test. Only an unsigned auth nonce is persisted. */
export async function smokeVercelApi(value: string) {
  const origin = validationOrigin(value);
  let stage = 'health';
  const results: { stage: string; status: number; result: string }[] = [];
  async function request(path: string, init?: RequestInit) {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    return { response, body: object(await response.json()) };
  }
  function pass(status: number) {
    results.push({ stage, status, result: 'PASS' });
  }
  try {
    const health = await request('/health', {
      headers: { Origin: 'https://app.wizpay.xyz' },
    });
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(
      health.response.headers.get('access-control-allow-origin'),
      'https://app.wizpay.xyz',
    );
    pass(200);
    stage = 'runtime isolation';
    const runtime = await request('/health/runtime-isolation');
    assert.equal(runtime.response.status, 200);
    assert.equal(runtime.body.network, 'arc-mainnet');
    assert.equal(runtime.body.environment, 'mainnet');
    assert(!('redis' in runtime.body) && !('queuePrefix' in runtime.body));
    const database = object(runtime.body.database);
    assert(
      typeof database.host === 'string' &&
        database.host.endsWith('.pooler.supabase.com'),
    );
    assert.equal(database.port, 6543);
    assert.equal(database.database, 'postgres');
    pass(200);
    stage = 'capabilities';
    const capabilities = await request('/capabilities');
    assert.equal(capabilities.response.status, 200);
    const data = object(capabilities.body.data);
    assert.equal(data.network, 'arc-mainnet');
    const enabled = object(data.capabilities);
    assert(Object.values(enabled).every((flag) => typeof flag === 'boolean'));
    pass(200);
    stage = 'database nonce persistence';
    // Random public address, no private key or signature is generated.
    const wallet = `0x${randomBytes(20).toString('hex')}`;
    const challenge = await request('/wallets/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet, chainId: 5042 }),
    });
    assert.equal(challenge.response.status, 201);
    const challengeData = object(challenge.body.data);
    assert.equal(typeof challengeData.challengeId, 'string');
    assert.equal(challengeData.chainId, 5042);
    pass(201);
    stage = 'Arc RPC and Uniswap read quorum';
    const readiness = await request('/user-swap/mainnet/readiness');
    assert.equal(readiness.response.status, 200);
    const ready = object(readiness.body.data);
    // HTTP 200 with available=false is not provider-connectivity success.
    assert.equal(ready.available, true);
    assert.equal(ready.poolIdentityStatus, 'verified-live');
    pass(200);
    if (enabled.swap === true || enabled.crossTokenPayroll === true) {
      stage = 'Uniswap read quote';
      const quote = await request('/user-swap/mainnet/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: 5042,
          tokenInAddress: ARC_MAINNET_UNISWAP_V4_USDC,
          tokenOutAddress: ARC_MAINNET_UNISWAP_V4_EURC,
          amountIn: '1000000',
          recipient: wallet,
          walletAddress: wallet,
          walletControl: 'external-wallet',
          slippageBps: 100,
          deadline: Math.floor(Date.now() / 1000) + 300,
        }),
      });
      assert.equal(quote.response.status, 201);
      assert(quote.body.data && typeof quote.body.data === 'object');
      pass(201);
    }
    if (enabled.bridge === true) {
      stage = 'Circle CCTP read quote';
      // Base Fast quote exercises Iris fee/allowance reads, not a burn/mint.
      const quote = await request(
        '/bridge/quote?sourceCode=BASE-MAINNET&destinationCode=ARC-MAINNET&amount=1000000',
      );
      assert.equal(quote.response.status, 200);
      assert.equal(object(quote.body.data).sourceCode, 'BASE-MAINNET');
      pass(200);
    }
    return results;
  } catch {
    // Never expose response bodies, driver messages, URLs or environment values.
    throw new Error(`Vercel API smoke failed at ${stage}.`);
  }
}

if (require.main === module) {
  void smokeVercelApi(process.env.WIZPAY_VERCEL_API_URL ?? '').then(
    (results) => console.log(JSON.stringify(results)),
    () => {
      console.error(
        'Vercel API smoke failed; inspect the safe stage results securely.',
      );
      process.exitCode = 1;
    },
  );
}
