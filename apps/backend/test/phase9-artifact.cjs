// Executed outside the checkout using only the traced Vercel function package.
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'bullmq' || name === 'ioredis')
    throw new Error('LEGACY_TRANSPORT_FORBIDDEN');
  return originalLoad.call(this, name, ...args);
};
// Deny every outbound fetch and TCP connect except the explicitly local test DB.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = args[0];
  const host = typeof options === 'object' ? options.host : args[1];
  if (
    typeof host === 'string' &&
    !['127.0.0.1', 'localhost', '::1'].includes(host)
  )
    throw new Error('NONLOCAL_TCP_FORBIDDEN');
  return originalConnect.apply(this, args);
};
const localFetch = global.fetch;
global.fetch = (url, init) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('NONLOCAL_HTTP_FORBIDDEN');
  return localFetch(url, init);
};
const handler = require('./apps/backend/api/index.cjs');
const {
  getServerlessApplication,
} = require('./apps/backend/dist/serverless.js');
const server = http.createServer(handler); // Test transport only. Application never listens.
let stage = 'startup';
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (let invocation = 0; invocation < 2; invocation++) {
    stage = 'health';
    const health = await fetch(base + '/health', {
      headers: { Origin: 'https://app.wizpay.xyz' },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(
      health.headers.get('access-control-allow-origin'),
      'https://app.wizpay.xyz',
    );
    assert.equal(
      (await fetch(base + '/capabilities').then((r) => r.json())).data.network,
      'arc-mainnet',
    );
    assert.equal((await fetch(base + '/activities')).status, 401);
    stage = 'checkout';
    const checkout = await fetch(
      base + '/public/invoices/p9aaaaaaaaaaaaaaaaaaaa',
    );
    assert.equal(checkout.status, 200);
    const publicData = (await checkout.json()).data;
    assert.equal(publicData.publicId, 'p9aaaaaaaaaaaaaaaaaaaa');
    assert.equal('merchantUserId' in publicData, false);
  }
  const app = await getServerlessApplication();
  assert.equal(app.getHttpServer().listening, false);
  await new Promise((resolve) => server.close(resolve));
  await app.close();
  console.log('PHASE9_LOCAL_ARTIFACT_PASS');
})().catch(async () => {
  server.close();
  const app = await getServerlessApplication().catch(() => null);
  if (app) await app.close();
  console.error('PHASE9_LOCAL_ARTIFACT_FAIL:' + stage);
  process.exitCode = 1;
});
