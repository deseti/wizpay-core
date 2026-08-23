import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Address,
} from 'viem';
import { AppWalletXylonetUserControlledExecutorService } from './app-wallet-xylonet-user-controlled-executor.service';

const EXECUTOR = '0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed';
const LEGACY_V1_EXECUTOR = '0x17685466759f9Cde06f0DCbB5464164ABe541eFA';
const ROUTER = '0x73742278c31a76dBb0D2587d03ef92E6E2141023';
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const WALLET = '0x3333333333333333333333333333333333333333';
const WALLET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_TOKEN = 'header.payload.signature';
const SAFE = '0xAA557eb00063ad487BFe0304Bd04B4d45114b721';

const request = {
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  walletId: WALLET_ID,
  walletAddress: WALLET,
  chain: 'ARC-TESTNET',
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '1000000',
  slippageBps: 200,
};

describe('AppWalletXylonetUserControlledExecutorService', () => {
  let rows: Map<string, any>;
  let prisma: any;
  let walletService: any;
  let w3s: any;
  let publicClient: any;
  let service: AppWalletXylonetUserControlledExecutorService;

  beforeEach(() => {
    process.env.APP_WALLET_XYLONET_USER_CONTROLLED_ENABLED = 'true';
    process.env.APP_XYLONET_CHAIN_ID = '5042002';
    process.env.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS = EXECUTOR;
    process.env.APP_XYLONET_ROUTER_ADDRESSES = ROUTER;
    process.env.APP_XYLONET_TOKEN_ADDRESSES = `USDC=${USDC},EURC=${EURC}`;
    process.env.APP_XYLONET_DEADLINE_MAX_SECONDS = '600';
    process.env.WIZPAY_FEE_SAFE = SAFE;

    rows = new Map();
    prisma = {
      appWalletXylonetOperation: {
        create: jest.fn(async ({ data }: any) => {
          const now = new Date();
          const row = {
            ...data,
            pollAttempts: 0,
            createdAt: now,
            updatedAt: now,
          };
          rows.set(row.operationId, row);
          return row;
        }),
        findUnique: jest.fn(
          async ({ where }: any) => rows.get(where.operationId) ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const current = rows.get(where.operationId);
          const nextData = { ...data };
          if (data.pollAttempts?.increment) {
            nextData.pollAttempts =
              current.pollAttempts + data.pollAttempts.increment;
          }
          const row = { ...current, ...nextData, updatedAt: new Date() };
          rows.set(where.operationId, row);
          return row;
        }),
      },
    };
    walletService = {
      syncWallets: jest.fn(async () => ({
        userId: 'circle:user:alice',
        wallets: [
          {
            walletId: WALLET_ID,
            address: WALLET,
            blockchain: 'ARC-TESTNET',
          },
        ],
      })),
    };
    w3s = {
      createUserContractExecutionChallenge: jest.fn(async () => ({
        challengeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      })),
      getUserChallenge: jest.fn(async (challengeId: string) => ({
        challenge: { id: challengeId, status: 'COMPLETED' },
      })),
      getUserTransaction: jest.fn(),
      listUserTransactions: jest.fn(async () => ({ transactions: [] })),
    };
    publicClient = {
      readContract: jest.fn(async (input: any) => {
        if (input.functionName === 'allowance') return 0n;
        if (input.functionName === 'getAmountOut') return 990_000n;
        if (
          input.functionName === 'owner' ||
          input.functionName === 'feeRecipient'
        )
          return SAFE;
        if (input.functionName === 'feeBps') return 25n;
        if (
          input.functionName === 'allowedRouters' ||
          input.functionName === 'allowedTokens'
        )
          return true;
        throw new Error(`Unexpected read ${input.functionName}`);
      }),
      getBytecode: jest.fn(async () => '0x6000'),
      getTransactionReceipt: jest.fn(),
      getTransaction: jest.fn(),
    };
    service = new AppWalletXylonetUserControlledExecutorService(
      prisma,
      walletService,
      w3s,
      publicClient,
    );
  });

  afterEach(() => {
    delete process.env.APP_WALLET_XYLONET_USER_CONTROLLED_ENABLED;
    delete process.env.APP_XYLONET_CHAIN_ID;
    delete process.env.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS;
    delete process.env.APP_XYLONET_ROUTER_ADDRESSES;
    delete process.env.APP_XYLONET_TOKEN_ADDRESSES;
    delete process.env.APP_XYLONET_DEADLINE_MAX_SECONDS;
    delete process.env.WIZPAY_FEE_SAFE;
  });

  it('fails closed before wallet lookup when disabled', async () => {
    process.env.APP_WALLET_XYLONET_USER_CONTROLLED_ENABLED = 'false';
    await expect(
      service.createOperation(request, USER_TOKEN),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(walletService.syncWallets).not.toHaveBeenCalled();
    expect(prisma.appWalletXylonetOperation.create).not.toHaveBeenCalled();
  });

  it('binds the operation to the authenticated Circle user and Arc wallet', async () => {
    const operation = await service.createOperation(request, USER_TOKEN);
    expect(walletService.syncWallets).toHaveBeenCalledWith({
      userToken: USER_TOKEN,
    });
    expect(operation.applicationUserId).toBe('circle:user:alice');
    expect(operation.circleWalletId).toBe(WALLET_ID);
    expect(operation.walletAddress).toBe(WALLET);
    expect(operation.executionMode).toBe('direct-user-controlled');
    expect(operation.provider).toBe('xylonet');
    expect(operation.executorAddress).toBe(EXECUTOR);
    expect(operation.executorAddress).not.toBe(LEGACY_V1_EXECUTOR);
    expect(operation.routerAddress).toBe(ROUTER);
  });

  it('supports the reverse EURC to USDC direction', async () => {
    const operation = await service.createOperation(
      {
        ...request,
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        tokenIn: 'EURC',
        tokenOut: 'USDC',
      },
      USER_TOKEN,
    );
    expect(operation.tokenInAddress).toBe(EURC);
    expect(operation.tokenOutAddress).toBe(USDC);
  });

  it('returns the existing operation for an identical idempotent request and rejects key reuse', async () => {
    const first = await service.createOperation(request, USER_TOKEN);
    const second = await service.createOperation(request, USER_TOKEN);
    expect(second.operationId).toBe(first.operationId);
    expect(prisma.appWalletXylonetOperation.create).toHaveBeenCalledTimes(1);
    await expect(
      service.createOperation({ ...request, amountIn: '2000000' }, USER_TOKEN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a wallet address that is not returned for the authenticated user', async () => {
    await expect(
      service.createOperation(
        {
          ...request,
          walletAddress: '0x4444444444444444444444444444444444444444',
        },
        USER_TOKEN,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.appWalletXylonetOperation.create).not.toHaveBeenCalled();
  });

  it('creates an exact approval challenge and propagates X-User-Token', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const updated = await service.createApprovalChallenge(
      created.operationId,
      USER_TOKEN,
    );

    expect(updated.lifecycleStage).toBe('awaiting_approval_confirmation');
    expect(updated.approvalChallengeId).toBe(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    const challengeInput =
      w3s.createUserContractExecutionChallenge.mock.calls[0][0];
    expect(challengeInput.userToken).toBe(USER_TOKEN);
    expect(challengeInput.walletId).toBe(WALLET_ID);
    expect(challengeInput.contractAddress).toBe(USDC);
    expect(challengeInput.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const decoded = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'approve',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const,
      data: challengeInput.callData,
    });
    expect(decoded.args).toEqual([EXECUTOR as Address, 1_000_000n]);
  });

  it('does not create a duplicate approval challenge', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    await service.createApprovalChallenge(created.operationId, USER_TOKEN);
    await service.createApprovalChallenge(created.operationId, USER_TOKEN);
    expect(w3s.createUserContractExecutionChallenge).toHaveBeenCalledTimes(1);
  });

  it('skips approval only when current allowance covers the exact input', async () => {
    const defaultRead = publicClient.readContract.getMockImplementation();
    publicClient.readContract.mockImplementation(async (input: any) =>
      input.functionName === 'allowance' ? 1_000_000n : defaultRead!(input),
    );
    const created = await service.createOperation(request, USER_TOKEN);
    const updated = await service.createApprovalChallenge(
      created.operationId,
      USER_TOKEN,
    );
    expect(updated.lifecycleStage).toBe('approval_confirmed');
    expect(w3s.createUserContractExecutionChallenge).not.toHaveBeenCalled();
  });

  it('uses a separate deterministic idempotency key for the swap challenge', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_confirmed',
    });
    w3s.createUserContractExecutionChallenge.mockResolvedValueOnce({
      challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    const updated = await service.createSwapChallenge(
      created.operationId,
      USER_TOKEN,
    );
    const challengeInput =
      w3s.createUserContractExecutionChallenge.mock.calls[0][0];
    expect(updated.swapChallengeId).toBe(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(challengeInput.contractAddress).toBe(EXECUTOR);
    expect(challengeInput.idempotencyKey).not.toBe(row.approvalIdempotencyKey);
    expect(challengeInput.userToken).toBe(USER_TOKEN);
    const decoded = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'executeSwap',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'router', type: 'address' },
            { name: 'tokenIn', type: 'address' },
            { name: 'tokenOut', type: 'address' },
            { name: 'amountIn', type: 'uint256' },
            { name: 'minAmountOut', type: 'uint256' },
            { name: 'recipient', type: 'address' },
            { name: 'deadline', type: 'uint256' },
          ],
          outputs: [{ name: 'amountOut', type: 'uint256' }],
        },
      ] as const,
      data: challengeInput.callData,
    });
    expect(decoded.args?.[0]).toBe(ROUTER);
    expect(decoded.args?.[1]).toBe(USDC);
    expect(decoded.args?.[2]).toBe(EURC);
    expect(decoded.args?.[3]).toBe(1_000_000n);
    expect(decoded.args?.[5]).toBe(WALLET);
  });

  it.each([
    ['CANCELLED', 'cancelled'],
    ['REJECTED', 'rejected'],
    ['EXPIRED', 'expired'],
    ['TIMED_OUT', 'timed_out'],
    ['FAILED', 'failed'],
  ])('persists %s challenge as terminal %s', async (status, terminal) => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'awaiting_approval_confirmation',
      approvalChallengeId: 'challenge',
    });
    const updated = await service.recordChallengeResult(
      created.operationId,
      'approval',
      { status },
      USER_TOKEN,
    );
    expect(updated.terminalStatus).toBe(terminal);
    expect(updated.lifecycleStage).toBe(terminal);
  });

  it.each(['PENDING', 'IN_PROGRESS', 'INITIATED', 'SUBMITTED'])(
    'keeps approval challenge status %s resumable',
    async (status) => {
      const created = await service.createOperation(request, USER_TOKEN);
      const row = rows.get(created.operationId);
      rows.set(created.operationId, {
        ...row,
        lifecycleStage: 'approval_submitted',
        approvalChallengeId: 'challenge',
      });
      w3s.getUserChallenge.mockResolvedValueOnce({
        challenge: { id: 'challenge', status },
      });

      const updated = await service.poll(created.operationId, USER_TOKEN);

      expect(updated.lifecycleStage).toBe('approval_submitted');
      expect(updated.terminalStatus).toBeUndefined();
      expect(w3s.getUserChallenge).toHaveBeenCalledWith(
        'challenge',
        USER_TOKEN,
      );
      expect(w3s.listUserTransactions).not.toHaveBeenCalled();
    },
  );

  it('accepts callback completion while Circle challenge status is still pending', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'awaiting_approval_confirmation',
      approvalChallengeId: 'challenge',
    });
    w3s.getUserChallenge.mockResolvedValueOnce({
      challenge: { id: 'challenge', status: 'PENDING' },
    });
    const updated = await service.recordChallengeResult(
      created.operationId,
      'approval',
      { status: 'COMPLETE' },
      USER_TOKEN,
    );
    expect(updated.lifecycleStage).toBe('approval_submitted');
    expect(updated.terminalStatus).toBeUndefined();
  });

  it.each([
    ['FAILED', 'failed'],
    ['CANCELLED', 'cancelled'],
    ['REJECTED', 'rejected'],
    ['EXPIRED', 'expired'],
  ])(
    'maps Circle approval challenge %s to terminal %s',
    async (status, terminal) => {
      const created = await service.createOperation(request, USER_TOKEN);
      const row = rows.get(created.operationId);
      rows.set(created.operationId, {
        ...row,
        lifecycleStage: 'approval_submitted',
        approvalChallengeId: 'challenge',
      });
      w3s.getUserChallenge.mockResolvedValueOnce({
        challenge: {
          id: 'challenge',
          status,
          errorMessage: `Circle approval ${terminal}`,
        },
      });

      const updated = await service.poll(created.operationId, USER_TOKEN);

      expect(updated.lifecycleStage).toBe(terminal);
      expect(updated.terminalStatus).toBe(terminal);
      expect(updated.failureReason).toBe(`Circle approval ${terminal}`);
      expect(w3s.listUserTransactions).not.toHaveBeenCalled();
    },
  );

  it('persists the completed challenge correlation id and confirms approval before one swap challenge', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: 'challenge',
    });
    const txHash = `0x${'c'.repeat(64)}`;
    w3s.getUserChallenge.mockResolvedValueOnce({
      challenge: {
        id: 'challenge',
        status: 'COMPLETED',
        correlationIds: ['approval-transaction'],
      },
    });
    w3s.getUserTransaction.mockResolvedValueOnce({
      transaction: {
        id: 'approval-transaction',
        state: 'COMPLETE',
        txHash,
        refId: `app-wallet-xylonet:${created.operationId}:approval`,
        walletId: WALLET_ID,
        sourceAddress: WALLET,
        contractAddress: USDC,
      },
    });
    publicClient.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      logs: [
        {
          address: USDC,
          topics: encodeEventTopics({
            abi: [
              {
                type: 'event',
                name: 'Approval',
                inputs: [
                  { name: 'owner', type: 'address', indexed: true },
                  { name: 'spender', type: 'address', indexed: true },
                  { name: 'value', type: 'uint256', indexed: false },
                ],
              },
            ] as const,
            eventName: 'Approval',
            args: { owner: WALLET, spender: EXECUTOR },
          }),
          data: encodeAbiParameters(parseAbiParameters('uint256'), [
            1_000_000n,
          ]),
        },
      ],
    });

    const confirmed = await service.poll(created.operationId, USER_TOKEN);
    expect(confirmed.lifecycleStage).toBe('approval_confirmed');
    expect(confirmed.approvalTransactionId).toBe('approval-transaction');
    expect(confirmed.approvalTransactionHash).toBe(txHash);
    expect(w3s.listUserTransactions).not.toHaveBeenCalled();

    w3s.createUserContractExecutionChallenge.mockResolvedValueOnce({
      challengeId: 'swap-challenge',
    });
    const swap = await service.createSwapChallenge(
      created.operationId,
      USER_TOKEN,
    );
    const retried = await service.createSwapChallenge(
      created.operationId,
      USER_TOKEN,
    );
    expect(swap.swapChallengeId).toBe('swap-challenge');
    expect(retried.swapChallengeId).toBe('swap-challenge');
    expect(w3s.createUserContractExecutionChallenge).toHaveBeenCalledTimes(1);
    expect(
      w3s.createUserContractExecutionChallenge.mock.calls[0][0].contractAddress,
    ).toBe(EXECUTOR);
  });

  it('rejects missing, mismatched, and unknown Circle challenge status safely', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: null,
    });
    await expect(
      service.poll(created.operationId, USER_TOKEN),
    ).rejects.toBeInstanceOf(ConflictException);

    rows.set(created.operationId, {
      ...row,
      pollAttempts: 0,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: 'challenge',
    });
    w3s.getUserChallenge.mockResolvedValueOnce({
      challenge: { id: 'wrong-challenge', status: 'COMPLETED' },
    });
    await expect(
      service.poll(created.operationId, USER_TOKEN),
    ).rejects.toBeInstanceOf(BadGatewayException);

    w3s.getUserChallenge.mockResolvedValueOnce({
      challenge: { id: 'challenge', status: 'FUTURE_STATUS' },
    });
    await expect(
      service.poll(created.operationId, USER_TOKEN),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a Circle challenge API error to a structured upstream failure', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: 'challenge',
    });
    const circleError = Object.assign(new Error('API parameter invalid'), {
      status: 400,
    });
    w3s.getUserChallenge.mockRejectedValueOnce(circleError);

    await expect(
      service.poll(created.operationId, USER_TOKEN),
    ).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({
        code: 'APP_WALLET_XYLONET_CIRCLE_FAILED',
        message: expect.stringContaining('challenge lookup failed (400)'),
      }),
    });
  });

  it('maps the transaction-list recovery error to 502 instead of HTTP 500', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: 'challenge',
    });
    w3s.getUserChallenge.mockResolvedValueOnce({
      challenge: { id: 'challenge', status: 'COMPLETED' },
    });
    w3s.listUserTransactions.mockRejectedValueOnce(
      Object.assign(new Error('API parameter invalid'), { status: 400 }),
    );

    await expect(
      service.poll(created.operationId, USER_TOKEN),
    ).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({
        code: 'APP_WALLET_XYLONET_CIRCLE_FAILED',
        message: expect.stringContaining(
          'transaction list lookup failed (400)',
        ),
      }),
    });
    expect(w3s.listUserTransactions).toHaveBeenCalledWith(
      { walletId: WALLET_ID },
      USER_TOKEN,
    );
  });

  it('retries a pending approval without creating a duplicate challenge', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: 'challenge',
    });
    w3s.getUserChallenge.mockResolvedValueOnce({
      challenge: { id: 'challenge', status: 'PENDING' },
    });

    await service.poll(created.operationId, USER_TOKEN);
    await service.createApprovalChallenge(created.operationId, USER_TOKEN);

    expect(w3s.createUserContractExecutionChallenge).not.toHaveBeenCalled();
    expect(rows.get(created.operationId).approvalChallengeId).toBe('challenge');
  });

  it('keeps pending Circle transactions resumable without creating duplicates', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: 'challenge',
    });
    const updated = await service.poll(created.operationId, USER_TOKEN);
    expect(updated.lifecycleStage).toBe('approval_submitted');
    expect(updated.terminalStatus).toBeUndefined();
    expect(updated.approvalChallengeId).toBe('challenge');
  });

  it('exposes receipt-verified actual output for a confirmed operation', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const txHash = `0x${'c'.repeat(64)}`;
    rows.set(created.operationId, {
      ...rows.get(created.operationId),
      lifecycleStage: 'completed',
      terminalStatus: 'confirmed',
      swapTransactionHash: txHash,
      completedAt: new Date(),
    });
    jest
      .spyOn(service as any, 'verifySwapReceipt')
      .mockResolvedValueOnce(987_654n);

    const completed = await service.poll(created.operationId, USER_TOKEN);

    expect(completed.verifiedActualOutput).toBe('987654');
  });

  it('maps a failed Circle transaction to an explicit terminal failure', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    rows.set(created.operationId, {
      ...row,
      lifecycleStage: 'approval_submitted',
      approvalChallengeId: 'challenge',
    });
    w3s.listUserTransactions.mockResolvedValueOnce({
      transactions: [
        {
          id: 'transaction',
          state: 'FAILED',
          refId: `app-wallet-xylonet:${created.operationId}:approval`,
          walletId: WALLET_ID,
          sourceAddress: WALLET,
          contractAddress: USDC,
        },
      ],
    });
    const updated = await service.poll(created.operationId, USER_TOKEN);
    expect(updated.lifecycleStage).toBe('failed');
    expect(updated.terminalStatus).toBe('failed');
  });

  it('resolves and persists a completed swap Circle transaction ID as the blockchain hash', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const txHash = `0x${'d'.repeat(64)}`;
    rows.set(created.operationId, {
      ...rows.get(created.operationId),
      lifecycleStage: 'completed',
      terminalStatus: 'confirmed',
      swapTransactionId: 'swap-transaction',
      swapTransactionHash: null,
      completedAt: new Date(),
    });
    w3s.getUserTransaction.mockResolvedValueOnce({
      data: {
        transaction: {
          id: 'swap-transaction',
          state: 'COMPLETE',
          txHash,
          walletId: WALLET_ID,
          sourceAddress: WALLET,
          contractAddress: EXECUTOR,
        },
      },
    });
    const completed = await service.getOperation(
      created.operationId,
      USER_TOKEN,
    );

    expect(w3s.getUserTransaction).toHaveBeenCalledWith(
      'swap-transaction',
      USER_TOKEN,
    );
    expect(rows.get(created.operationId).swapTransactionHash).toBe(txHash);
    expect(completed.swapTransactionHash).toBe(txHash);
    expect(completed.lifecycleStage).toBe('completed');
    expect(completed.terminalStatus).toBe('confirmed');
  });

  it('keeps a completed swap hash pending when Circle has not returned txHash', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    rows.set(created.operationId, {
      ...rows.get(created.operationId),
      lifecycleStage: 'completed',
      terminalStatus: 'confirmed',
      swapTransactionId: 'swap-transaction',
      swapTransactionHash: null,
      completedAt: new Date(),
    });
    w3s.getUserTransaction.mockResolvedValueOnce({
      transaction: {
        id: 'swap-transaction',
        state: 'COMPLETE',
        walletId: WALLET_ID,
        sourceAddress: WALLET,
        contractAddress: EXECUTOR,
      },
    });

    const completed = await service.getOperation(
      created.operationId,
      USER_TOKEN,
    );

    expect(completed.swapTransactionHash).toBeUndefined();
    expect(completed.lifecycleStage).toBe('completed');
  });

  it('verifies the executor event and output transfer for a Smart Contract Account receipt', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    const amountOut = 980_000n;
    publicClient.getTransaction.mockResolvedValue({ to: null, input: '0x' });
    publicClient.getTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        {
          address: EXECUTOR,
          topics: encodeEventTopics({
            abi: [
              {
                type: 'event',
                name: 'WizPaySwapExecuted',
                inputs: [
                  { name: 'user', type: 'address', indexed: true },
                  { name: 'router', type: 'address', indexed: true },
                  { name: 'tokenIn', type: 'address', indexed: true },
                  { name: 'tokenOut', type: 'address', indexed: false },
                  { name: 'amountIn', type: 'uint256', indexed: false },
                  { name: 'feeAmount', type: 'uint256', indexed: false },
                  { name: 'netAmountIn', type: 'uint256', indexed: false },
                  { name: 'amountOut', type: 'uint256', indexed: false },
                  { name: 'recipient', type: 'address', indexed: false },
                ],
              },
            ] as const,
            eventName: 'WizPaySwapExecuted',
            args: { user: WALLET, router: ROUTER, tokenIn: USDC },
          }),
          data: encodeAbiParameters(
            parseAbiParameters(
              'address,uint256,uint256,uint256,uint256,address',
            ),
            [EURC, 1_000_000n, 2_500n, 997_500n, amountOut, WALLET],
          ),
        },
        {
          address: EURC,
          topics: encodeEventTopics({
            abi: [
              {
                type: 'event',
                name: 'Transfer',
                inputs: [
                  { name: 'from', type: 'address', indexed: true },
                  { name: 'to', type: 'address', indexed: true },
                  { name: 'value', type: 'uint256', indexed: false },
                ],
              },
            ] as const,
            eventName: 'Transfer',
            args: { from: ROUTER, to: WALLET },
          }),
          data: encodeAbiParameters(parseAbiParameters('uint256'), [amountOut]),
        },
      ],
    });

    await expect(
      (service as any).verifySwapReceipt(row, `0x${'a'.repeat(64)}`),
    ).resolves.toBe(amountOut.toString());
  });

  it('rejects an executor event whose output is below the persisted minimum', async () => {
    const created = await service.createOperation(request, USER_TOKEN);
    const row = rows.get(created.operationId);
    const amountOut = 1n;
    publicClient.getTransaction.mockResolvedValue({ to: null, input: '0x' });
    publicClient.getTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        {
          address: EXECUTOR,
          topics: encodeEventTopics({
            abi: [
              {
                type: 'event',
                name: 'WizPaySwapExecuted',
                inputs: [
                  { name: 'user', type: 'address', indexed: true },
                  { name: 'router', type: 'address', indexed: true },
                  { name: 'tokenIn', type: 'address', indexed: true },
                  { name: 'tokenOut', type: 'address' },
                  { name: 'amountIn', type: 'uint256' },
                  { name: 'feeAmount', type: 'uint256' },
                  { name: 'netAmountIn', type: 'uint256' },
                  { name: 'amountOut', type: 'uint256' },
                  { name: 'recipient', type: 'address' },
                ],
              },
            ] as const,
            eventName: 'WizPaySwapExecuted',
            args: { user: WALLET, router: ROUTER, tokenIn: USDC },
          }),
          data: encodeAbiParameters(
            parseAbiParameters(
              'address,uint256,uint256,uint256,uint256,address',
            ),
            [EURC, 1_000_000n, 2_500n, 997_500n, amountOut, WALLET],
          ),
        },
      ],
    });
    await expect(
      (service as any).verifySwapReceipt(row, `0x${'b'.repeat(64)}`),
    ).rejects.toThrow('below minimumOutput');
  });

  it('rejects stale chain and missing executor configuration before persistence', async () => {
    process.env.APP_XYLONET_CHAIN_ID = '5042001';
    await expect(
      service.createOperation(request, USER_TOKEN),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.APP_XYLONET_CHAIN_ID = '5042002';
    process.env.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS = '';
    await expect(
      service.createOperation(request, USER_TOKEN),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.appWalletXylonetOperation.create).not.toHaveBeenCalled();
  });
});
