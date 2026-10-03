/* Test driver, supplied on stdin to a copied production function artifact.
 * Synthetic RPC evidence goes through the real operation-specific verifiers.
 * Authentication signatures arrive via IPC from ephemeral test accounts.
 * No financial signing, broadcasting, public network calls or credential logs.
 */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const Module = require('node:module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'bullmq' || name === 'ioredis')
    throw Error('Redis transport forbidden');
  return load.call(this, name, ...args);
};
const viem = require('viem');
const handler = require('./apps/backend/api/index.cjs');
const { getServerlessApplication } = require('./apps/backend/dist/serverless');
const service = (path, name) => require('./apps/backend/dist/' + path)[name];
const PrismaService = service('database/prisma.service', 'PrismaService');
const server = createServer(handler); // Only the test harness owns a listener.
const transfer = viem.parseAbi([
  'function transfer(address recipient, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const token = '0x3600000000000000000000000000000000000000';
const recipient = '0x1000000000000000000000000000000000000001';
const sendHash = '0x' + '1'.repeat(64);
const invoiceHash = '0x' + '2'.repeat(64);
let stage = 'startup';
let app;
const receive = () =>
  new Promise((resolve) => process.once('message', resolve));
const signature = async (message, wrong = false) => {
  const pending = receive();
  process.send({ action: 'sign', message, wrong });
  return (await pending).signature;
};
async function run({ address, otherAddress, state }) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, body, session, status = body ? 201 : 200) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: 'Bearer ' + session } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (response.status !== status) {
      // Only numeric status and an application code from a fixed safe pattern.
      const code =
        typeof payload.code === 'string' && /^[A-Z_]+$/.test(payload.code)
          ? payload.code
          : 'NONE';
      stage += ':HTTP_' + response.status + '_' + code;
    }
    assert.equal(response.status, status);
    return payload.data;
  };
  await Promise.all([
    request('/health'),
    request('/health'),
    request('/health'),
  ]);
  app = await getServerlessApplication();
  assert.equal(app.getHttpServer().listening, false);
  const prisma = app.get(PrismaService);
  // Keep real signature validation, replacing only optional RPC fallback.
  app.get(
    service('modules/wallet/wallet-auth.service', 'WalletAuthService'),
  ).publicClient = { verifyMessage: viem.verifyMessage };
  stage = 'capability parity';
  const capabilities = await request('/capabilities');
  for (const name of [
    'send',
    'sameTokenPayroll',
    'invoice',
    'paymentLink',
    'swap',
    'bridge',
    'crossTokenPayroll',
  ])
    assert.equal(capabilities.capabilities[name], true);
  for (const name of ['liquidity', 'crossTokenInvoice', 'nanoAgentApi'])
    assert.equal(capabilities.capabilities[name], false);
  if (state) {
    stage = 'cold restart persistence';
    const invoices = await request('/invoices', null, state.session);
    assert.equal(invoices.total, 2);
    const intent = await request(
      '/execution-intents/' + state.intent.id + '/recover',
      { idempotencyKey: state.intent.idempotencyKey },
    );
    assert.equal(intent.status, 'COMPLETED');
    assert.equal(intent.transactionHash, sendHash);
    assert.ok(intent.completedAt);
    assert.equal(
      (await request('/public/invoices/' + state.invoice.publicId)).status,
      'PAID',
    );
    const activities = await request('/activities', null, state.session);
    assert.ok(activities.items.length >= 1);
    stage = 'revoke survives persistence';
    await request('/wallets/auth/revoke', {}, state.session);
    await request('/invoices', null, state.session, 401);
    return state;
  }
  stage = 'wallet authentication negative cases';
  await request('/wallets/auth/challenge', { address, chainId: 1 }, null, 401);
  const bad = await request('/wallets/auth/challenge', {
    address,
    chainId: 5042,
  });
  await request(
    '/wallets/auth/verify',
    {
      challengeId: bad.challengeId,
      signature: await signature(bad.message, true),
    },
    null,
    401,
  );
  await prisma.walletAuthChallenge.update({
    where: { id: bad.challengeId },
    data: { expiresAt: new Date(0) },
  });
  await request(
    '/wallets/auth/verify',
    { challengeId: bad.challengeId, signature: await signature(bad.message) },
    null,
    401,
  );
  const challenge = await request('/wallets/auth/challenge', {
    address: address.toLowerCase(),
    chainId: 5042,
  });
  const signed = await signature(challenge.message);
  const auth = await request('/wallets/auth/verify', {
    challengeId: challenge.challengeId,
    signature: signed,
  });
  assert.equal(auth.address.toLowerCase(), address.toLowerCase());
  await request(
    '/wallets/auth/verify',
    { challengeId: challenge.challengeId, signature: signed },
    null,
    401,
  );
  await request('/invoices', null, null, 401);
  stage = 'invoice and payment link HTTP';
  const invoice = await request(
    '/invoices',
    {
      token: 'USDC',
      amount: '0.01',
      title: 'Synthetic acceptance invoice',
      invoiceNumber: 'private-number',
    },
    auth.sessionToken,
  );
  const link = await request(
    '/invoices',
    {
      token: 'USDC',
      amount: '0.02',
      title: 'Synthetic payment link',
      settlementKind: 'PAYMENT_LINK',
    },
    auth.sessionToken,
  );
  const checkout = await request('/public/invoices/' + invoice.publicId);
  assert.equal(checkout.receivingAddress.toLowerCase(), address.toLowerCase());
  for (const key of ['merchantUserId', 'invoiceNumber', 'id', 'payerAddress'])
    assert.equal(key in checkout, false);
  await request(
    '/invoices',
    { token: 'USDC', amount: '0.0000001', title: 'invalid' },
    auth.sessionToken,
    400,
  );
  await request('/public/invoices/invalid', null, null, 404);
  await request('/invoices/' + link.id + '/cancel', {}, auth.sessionToken);
  assert.equal(
    (await request('/public/invoices/' + link.publicId)).status,
    'CANCELLED',
  );
  stage = 'known hash Send and duplicate identity';
  const input = {
    network: 'arc-mainnet',
    operation: 'SEND',
    sourceWallet: address,
    recipient,
    tokenIn: token,
    tokenOut: token,
    amountUnits: '10000',
    externalReference: 'phase8-send',
  };
  await request(
    '/execution-intents/acquire',
    { ...input, network: 'arc-testnet' },
    null,
    400,
  );
  const intent = await request('/execution-intents/acquire', input);
  assert.equal(
    (await request('/execution-intents/acquire', input)).id,
    intent.id,
  );
  assert.equal(intent.status, 'CREATED');
  assert.equal(intent.transactionHash, null);
  await request(
    '/execution-intents/' + intent.id + '/recover-hash',
    { idempotencyKey: 'wrong', transactionHash: sendHash },
    null,
    409,
  );
  const evidence = (hash, to, amount, from = address) => {
    const transaction = {
      hash,
      chainId: 5042,
      from,
      to: token,
      value: 0n,
      input: viem.encodeFunctionData({
        abi: transfer,
        functionName: 'transfer',
        args: [to, amount],
      }),
    };
    const receipt = {
      transactionHash: hash,
      status: 'success',
      blockNumber: 100n,
      logs: [
        {
          address: token,
          data: viem.encodeAbiParameters([{ type: 'uint256' }], [amount]),
          topics: viem.encodeEventTopics({
            abi: transfer,
            eventName: 'Transfer',
            args: { from, to },
          }),
          logIndex: 0,
        },
      ],
    };
    return {
      getChainId: async () => 5042,
      getTransaction: async () => transaction,
      getTransactionReceipt: async () => receipt,
      getBlockNumber: async () => 102n,
    };
  };
  const receipts = app.get(
    service(
      'execution-intent/direct-transfer-receipt-verifier.service',
      'DirectTransferReceiptVerifierService',
    ),
  );
  receipts.publicClient = evidence(sendHash, recipient, 9999n);
  await request('/execution-intents/' + intent.id + '/recover-hash', {
    idempotencyKey: intent.idempotencyKey,
    transactionHash: sendHash,
  });
  await request(
    '/execution-intents/' + intent.id + '/verify',
    { idempotencyKey: intent.idempotencyKey },
    null,
    422,
  );
  assert.notEqual(
    (await prisma.executionIntent.findUnique({ where: { id: intent.id } }))
      .status,
    'COMPLETED',
  );
  receipts.publicClient = evidence(sendHash, recipient, 10000n);
  const complete = await request(
    '/execution-intents/' + intent.id + '/verify',
    { idempotencyKey: intent.idempotencyKey },
  );
  assert.equal(complete.status, 'COMPLETED');
  await request('/execution-intents/' + intent.id + '/verify', {
    idempotencyKey: intent.idempotencyKey,
  });
  assert.equal(
    await prisma.executionIntent.count({ where: { operation: 'SEND' } }),
    1,
  );
  stage = 'payment receipt and duplicate verification';
  const settlement = await request('/execution-intents/acquire', {
    ...input,
    operation: 'INVOICE_SETTLEMENT',
    sourceWallet: otherAddress,
    recipient: address,
    externalReference: invoice.publicId,
  });
  await request('/execution-intents/' + settlement.id + '/recover-hash', {
    idempotencyKey: settlement.idempotencyKey,
    transactionHash: invoiceHash,
  });
  app.get(
    service(
      'invoice/invoice-payment-verifier.service',
      'InvoicePaymentVerifierService',
    ),
  ).publicClient = evidence(invoiceHash, address, 10000n, otherAddress);
  await request('/public/invoices/' + invoice.publicId + '/payments/verify', {
    transactionHash: invoiceHash,
  });
  await request('/public/invoices/' + invoice.publicId + '/payments/verify', {
    transactionHash: invoiceHash,
  });
  assert.equal(
    await prisma.invoicePayment.count({ where: { status: 'VERIFIED' } }),
    1,
  );
  assert.equal(
    (await request('/public/invoices/' + invoice.publicId)).status,
    'PAID',
  );
  stage = 'ownership isolation';
  const otherChallenge = await request('/wallets/auth/challenge', {
    address: otherAddress,
    chainId: 5042,
  });
  const otherAuth = await request('/wallets/auth/verify', {
    challengeId: otherChallenge.challengeId,
    signature: await signature(otherChallenge.message, true),
  });
  await request('/invoices/' + invoice.id, null, otherAuth.sessionToken, 404);
  assert.equal(
    (await request('/invoices', null, otherAuth.sessionToken)).total,
    0,
  );
  const otherActivity = await request(
    '/activities',
    null,
    otherAuth.sessionToken,
  );
  assert.equal(
    otherActivity.items.some((item) => item.type === 'send'),
    false,
  );
  await request('/activities/sync', {}, auth.sessionToken);
  const activityCount = await prisma.activity.count();
  await request('/activities/sync', {}, auth.sessionToken);
  assert.equal(await prisma.activity.count(), activityCount);
  const activities = await request('/activities', null, auth.sessionToken);
  assert.ok(activities.items.length >= 1);
  assert.equal(
    activities.items.some((item) => item.ownerUserId === 'other-fixture-owner'),
    false,
  );
  stage = 'payroll preparation without Redis';
  app.get(service('task/task.service', 'TaskService')).readPayrollFeeBps =
    async () => 25n;
  const payroll = await request('/tasks/payroll/init', {
    walletAddress: address,
    sourceToken: 'USDC',
    sourceTokenAddress: token,
    referenceId: 'phase8-payroll',
    recipients: [
      {
        address: recipient,
        amount: '0.01',
        targetToken: 'USDC',
        targetTokenAddress: token,
      },
    ],
  });
  assert.ok(payroll);
  assert.equal(await prisma.task.count(), 1);
  assert.equal(await prisma.taskUnit.count(), 1);
  stage = 'payroll history and owned tasks';
  const blockchain = app.get(
    service('adapters/blockchain.service', 'BlockchainService'),
  );
  blockchain.getBlockNumberOnChain = async () => 0n;
  const history = await request('/tasks/payroll/history?wallet=' + address);
  assert.ok(history);
  await request('/tasks', null, auth.sessionToken);
  stage = 'Swap and Bridge request guards';
  await request('/user-swap/mainnet/quote', {}, null, 400);
  await request('/user-swap/mainnet/prepare', { chainId: 1 }, null, 400);
  await request('/bridge/intents', { sourceCode: 'ARC-TESTNET' }, null, 400);
  await request(
    '/user-swap/mainnet/confirm',
    { transactionHash: 'wrong' },
    auth.sessionToken,
    400,
  );
  stage = 'shared bounded reconciliation';
  const {
    runReconciliationBatch,
  } = require('./apps/backend/dist/reconciliation');
  const summary = await runReconciliationBatch({ limit: 1 });
  assert.ok(summary.claimed <= 1);
  return { session: auth.sessionToken, intent, invoice };
}
(async () => {
  const pending = receive();
  process.send({ action: 'ready' });
  const state = await run(await pending);
  await new Promise((resolve) => server.close(resolve));
  await app.close();
  process.send({ action: 'pass', state });
  process.disconnect();
})().catch(async () => {
  server.close();
  if (app) await app.close();
  process.send({ action: 'fail', stage });
  process.disconnect();
  process.exitCode = 1;
});
