import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  padHex,
  parseAbi,
} from 'viem';
import {
  ARC_MAINNET_USDC_NATIVE_SCALE,
  ARC_NATIVE_USDC_TRANSFER_EMITTER,
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_POOL_KEY,
  ARC_MAINNET_UNISWAP_V4_QUOTER,
  ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
  ARC_MAINNET_UNISWAP_V4_USDC,
  applySlippage,
  assertCandidatePoolKeyMatchesEvidence,
  buildPermit2TypedData,
  buildUserControlledSwapPlan,
  calculateMinHopPriceX36,
  decodeQuoteExactInputSingleResult,
  deriveMainnetUniswapV4PoolId,
  encodePermit2PermitAndSwap,
  encodeQuoteExactInputSingle,
  encodeUniversalRouterExactInput,
  verifySwapReceipt,
  zeroForOneFromTokens,
} from './mainnet-uniswap-v4-protocol';
import type { NormalizedMainnetUniswapV4BoundaryRequest } from './mainnet-uniswap-v4-readiness.service';

const USER = '0x1234567890123456789012345678901234567890' as const;
const NOW = 2_000_000_000;
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const SWAP_TOPIC =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as const;
const ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
]);

function transferLog(
  token: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
) {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC,
      padHex(from, { size: 32 }),
      padHex(to, { size: 32 }),
    ],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

function request(
  overrides: Partial<NormalizedMainnetUniswapV4BoundaryRequest> = {},
): NormalizedMainnetUniswapV4BoundaryRequest {
  return Object.freeze({
    chainId: 5_042,
    tokenInAddress: ARC_MAINNET_UNISWAP_V4_USDC,
    tokenOutAddress: ARC_MAINNET_UNISWAP_V4_EURC,
    amountIn: 1_000_000n,
    recipient: USER,
    walletAddress: USER,
    walletControl: 'external-wallet',
    slippageBps: 50,
    deadline: NOW + 300,
    ...overrides,
  });
}

function observation(
  input = request(),
  overrides: Record<string, unknown> = {},
) {
  return {
    chainId: 5_042,
    quoterAddress: ARC_MAINNET_UNISWAP_V4_QUOTER,
    poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
    tokenInAddress: input.tokenInAddress,
    tokenOutAddress: input.tokenOutAddress,
    amountIn: input.amountIn.toString(),
    blockNumber: 21_190_503,
    amountOut: '864736',
    gasEstimate: '37217',
    ...overrides,
  };
}

function swapLog(amount0: bigint, amount1: bigint) {
  return {
    address: ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
    topics: [
      SWAP_TOPIC,
      ARC_MAINNET_UNISWAP_V4_POOL_ID,
      padHex(ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER, { size: 32 }),
    ],
    data: encodeAbiParameters(
      [
        { type: 'int128' },
        { type: 'int128' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
        { type: 'uint24' },
      ],
      [amount0, amount1, 1n, 1n, 0, 500],
    ),
  };
}

describe('mainnet Uniswap V4 protocol', () => {
  it('recomputes the candidate PoolId from the canonical PoolKey', () => {
    expect(deriveMainnetUniswapV4PoolId()).toBe(ARC_MAINNET_UNISWAP_V4_POOL_ID);
    expect(
      assertCandidatePoolKeyMatchesEvidence(ARC_MAINNET_UNISWAP_V4_POOL_ID),
    ).toBe(ARC_MAINNET_UNISWAP_V4_POOL_ID);
    expect(ARC_MAINNET_UNISWAP_V4_POOL_KEY).toMatchObject({
      currency0: ARC_MAINNET_UNISWAP_V4_USDC,
      currency1: ARC_MAINNET_UNISWAP_V4_EURC,
      fee: 500,
      tickSpacing: 10,
    });
    const evidence = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          '../../packages/contracts/deployments/resource-evidence/arc-mainnet-uniswap-v4-usdc-eurc.candidate.json',
        ),
        'utf8',
      ),
    ) as {
      status: string;
      conclusions: {
        executable: boolean;
        uniquenessResolved: boolean;
        poolKeySafeToAdopt: boolean;
        poolIdSafeToAdopt: boolean;
      };
      candidates: Array<{ poolKey: unknown; emittedPoolId: string }>;
    };
    expect(evidence.status).toBe('candidate-non-executable');
    expect(evidence.conclusions.executable).toBe(false);
    expect(evidence.conclusions.uniquenessResolved).toBe(false);
    expect(evidence.conclusions.poolKeySafeToAdopt).toBe(false);
    expect(evidence.conclusions.poolIdSafeToAdopt).toBe(false);
    expect(evidence.candidates[0].poolKey).toMatchObject(
      ARC_MAINNET_UNISWAP_V4_POOL_KEY,
    );
    expect(evidence.candidates[0].emittedPoolId).toBe(
      ARC_MAINNET_UNISWAP_V4_POOL_ID,
    );
  });

  it('quotes USDC to EURC zeroForOne and EURC to USDC oneForZero', () => {
    expect(
      zeroForOneFromTokens(
        ARC_MAINNET_UNISWAP_V4_USDC,
        ARC_MAINNET_UNISWAP_V4_EURC,
      ),
    ).toBe(true);
    expect(
      zeroForOneFromTokens(
        ARC_MAINNET_UNISWAP_V4_EURC,
        ARC_MAINNET_UNISWAP_V4_USDC,
      ),
    ).toBe(false);
  });

  it('encodes a nested quoteExactInputSingle call to the published quoter', () => {
    const data = encodeQuoteExactInputSingle({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
    });
    expect(data.startsWith('0x')).toBe(true);
    expect(data.length).toBeGreaterThan(10);
    const decoded = decodeQuoteExactInputSingleResult(
      encodeFunctionResult({
        abi: [
          {
            type: 'function',
            name: 'quoteExactInputSingle',
            stateMutability: 'nonpayable',
            inputs: [],
            outputs: [
              { name: 'amountOut', type: 'uint256' },
              { name: 'gasEstimate', type: 'uint256' },
            ],
          },
        ],
        functionName: 'quoteExactInputSingle',
        result: [864_736n, 37_217n],
      }),
    );
    expect(decoded).toEqual({ amountOut: 864_736n, gasEstimate: 37_217n });
  });

  it('builds a fail-closed native-USDC plan without Permit2 approvals', () => {
    const plan = buildUserControlledSwapPlan(request(), observation());
    expect(plan.executable).toBe(false);
    expect(plan.quote.minAmountOut).toBe(applySlippage(864_736n, 50));
    expect(plan.quote.minHopPriceX36).toBe(
      calculateMinHopPriceX36(1_000_000n, 864_736n, 50),
    );
    expect(plan.approvals).toHaveLength(0);
    expect(plan.permit2).toBeNull();
    expect(plan.swap.value).toBe(1_000_000n * ARC_MAINNET_USDC_NATIVE_SCALE);
    expect(plan.swap.to).toBe(ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER);
    expect(plan.swap.data.startsWith('0x')).toBe(true);
    expect(ARC_MAINNET_UNISWAP_V4_QUOTER).toMatch(/^0x8dc178ef/i);
  });

  it('encodes the deployed V4 exact-input path and binds TAKE to the wallet', () => {
    const plan = buildUserControlledSwapPlan(request(), observation());
    const decoded = decodeFunctionData({
      abi: ROUTER_ABI,
      data: plan.swap.data,
    });
    expect(decoded.args[0]).toBe('0x10');
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      decoded.args[1][0],
    );
    expect(actions).toBe('0x070b0e');
    const [exactInput] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currencyIn', type: 'address' },
            {
              name: 'path',
              type: 'tuple[]',
              components: [
                { name: 'intermediateCurrency', type: 'address' },
                { name: 'fee', type: 'uint24' },
                { name: 'tickSpacing', type: 'int24' },
                { name: 'hooks', type: 'address' },
                { name: 'hookData', type: 'bytes' },
              ],
            },
            { name: 'minHopPriceX36', type: 'uint256[]' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
          ],
        },
      ],
      params[0],
    );
    expect(exactInput).toMatchObject({
      currencyIn: ARC_MAINNET_UNISWAP_V4_USDC,
      amountIn: 1_000_000n,
      minHopPriceX36: [calculateMinHopPriceX36(1_000_000n, 864_736n, 50)],
      path: [
        expect.objectContaining({
          intermediateCurrency: ARC_MAINNET_UNISWAP_V4_EURC,
          fee: 500,
          tickSpacing: 10,
        }),
      ],
    });
    const [settleCurrency, settleAmount, payerIsUser] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
      params[1],
    );
    expect([settleCurrency, settleAmount, payerIsUser]).toEqual([
      ARC_MAINNET_UNISWAP_V4_USDC,
      0n,
      false,
    ]);
    const [takeCurrency, recipient, takeAmount] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      params[2],
    );
    expect([takeCurrency, recipient, takeAmount]).toEqual([
      ARC_MAINNET_UNISWAP_V4_EURC,
      USER,
      0n,
    ]);
  });

  it('encodes a Permit2 permit plus V4 swap for external wallets only', () => {
    const reverse = request({
      tokenInAddress: ARC_MAINNET_UNISWAP_V4_EURC,
      tokenOutAddress: ARC_MAINNET_UNISWAP_V4_USDC,
    });
    const plan = buildUserControlledSwapPlan(
      reverse,
      observation(reverse, { amountOut: '1155265', gasEstimate: '36933' }),
    );
    const bundled = encodePermit2PermitAndSwap({
      quote: plan.quote,
      recipient: USER,
      deadline: plan.deadline,
      nonce: 0,
      signature: `0x${'11'.repeat(65)}`,
    });
    const swapOnly = encodeUniversalRouterExactInput(
      plan.quote,
      USER,
      plan.deadline,
    );
    expect(bundled).not.toBe(swapOnly);
    expect(bundled.startsWith(swapOnly.slice(0, 10))).toBe(true);
    expect(plan.approvals).toHaveLength(2);
    expect(plan.permit2?.spender).toBe(ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER);
    expect(plan.swap.value).toBe(0n);
    expect(decodeFunctionData({ abi: ROUTER_ABI, data: bundled }).args[0]).toBe(
      '0x0a10',
    );
    const decoded = decodeFunctionData({
      abi: ROUTER_ABI,
      data: plan.swap.data,
    });
    const [, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      decoded.args[1][0],
    );
    const [, , payerIsUser] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
      params[1],
    );
    expect(payerIsUser).toBe(true);
  });

  it.each([
    {
      transactionHash:
        '0xf06b3035ca97902897906d7d89eeaecba7a9de484db031f1a51f8a914f0dfd07',
      tokenInAddress: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOutAddress: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 100_000n,
      amountOut: '87169',
      minAmountOut: 84_989n,
      minHopPriceX36: 849_897_750_000_000_000_000_000_000_000_000_000n,
      payerIsUser: false,
    },
    {
      transactionHash:
        '0x8b080d9a77d033ec7a5da8a7b555012064481b1f7ce85b9f419e32d81543215a',
      tokenInAddress: ARC_MAINNET_UNISWAP_V4_EURC,
      tokenOutAddress: ARC_MAINNET_UNISWAP_V4_USDC,
      amountIn: 87_169n,
      amountOut: '99899',
      minAmountOut: 97_401n,
      minHopPriceX36: 1_117_387_201_872_225_217_680_597_460_106_230_425n,
      payerIsUser: true,
    },
  ])(
    'matches the decoded exact-input floors and payer for $transactionHash',
    (vector) => {
      const swapRequest = request({
        tokenInAddress: vector.tokenInAddress,
        tokenOutAddress: vector.tokenOutAddress,
        amountIn: vector.amountIn,
        slippageBps: 250,
      });
      const plan = buildUserControlledSwapPlan(
        swapRequest,
        observation(swapRequest, { amountOut: vector.amountOut }),
      );
      expect(plan.quote.minAmountOut).toBe(vector.minAmountOut);
      expect(plan.quote.minHopPriceX36).toBe(vector.minHopPriceX36);
      const decoded = decodeFunctionData({
        abi: ROUTER_ABI,
        data: plan.swap.data,
      });
      const [, params] = decodeAbiParameters(
        [{ type: 'bytes' }, { type: 'bytes[]' }],
        decoded.args[1][0],
      );
      const [exactInput] = decodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 'currencyIn', type: 'address' },
              {
                name: 'path',
                type: 'tuple[]',
                components: [
                  { name: 'intermediateCurrency', type: 'address' },
                  { name: 'fee', type: 'uint24' },
                  { name: 'tickSpacing', type: 'int24' },
                  { name: 'hooks', type: 'address' },
                  { name: 'hookData', type: 'bytes' },
                ],
              },
              { name: 'minHopPriceX36', type: 'uint256[]' },
              { name: 'amountIn', type: 'uint128' },
              { name: 'amountOutMinimum', type: 'uint128' },
            ],
          },
        ],
        params[0],
      );
      expect(exactInput.minHopPriceX36).toEqual([vector.minHopPriceX36]);
      const [, , payerIsUser] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
        params[1],
      );
      expect(payerIsUser).toBe(vector.payerIsUser);
    },
  );

  it('rejects non-canonical quotes and non-router Permit2 spenders', () => {
    expect(() =>
      buildUserControlledSwapPlan(request(), {
        ...observation(),
        amountOut: '0864736',
      }),
    ).toThrow(/canonical/);
    expect(() =>
      buildUserControlledSwapPlan(
        request(),
        observation(request(), { quoterAddress: USER }),
      ),
    ).toThrow(/does not match/);
    expect(() =>
      buildPermit2TypedData({
        token: ARC_MAINNET_UNISWAP_V4_EURC,
        amount: 1_000_000n,
        spender: USER,
        nonce: 0,
        deadline: NOW + 300,
      }),
    ).toThrow(/Universal Router/);
    expect(() =>
      buildPermit2TypedData({
        token: ARC_MAINNET_UNISWAP_V4_USDC,
        amount: 1_000_000n,
        spender: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
        nonce: 0,
        deadline: NOW + 300,
      }),
    ).toThrow(/EURC/);
  });

  it('verifies native input, PoolId, exact calldata, and actual output', () => {
    const directRequest = request({ amountIn: 100_000n });
    const plan = buildUserControlledSwapPlan(
      directRequest,
      observation(directRequest, { amountOut: '87169' }),
    );
    const verified = verifySwapReceipt(
      {
        chainId: 5_042,
        status: 'success',
        from: USER,
        to: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
        input: plan.swap.data,
        value: plan.swap.value.toString(),
        logs: [
          transferLog(
            ARC_NATIVE_USDC_TRANSFER_EMITTER,
            USER,
            ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
            plan.swap.value,
          ),
          swapLog(-100_000n, 87_169n),
          transferLog(
            ARC_MAINNET_UNISWAP_V4_USDC,
            ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
            ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
            100_000n,
          ),
          transferLog(
            ARC_MAINNET_UNISWAP_V4_EURC,
            ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
            USER,
            87_169n,
          ),
        ],
      },
      {
        walletAddress: USER,
        recipient: USER,
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        amountIn: 100_000n,
        minAmountOut: plan.quote.minAmountOut,
        transactionData: plan.swap.data,
        transactionValue: plan.swap.value,
        zeroForOne: true,
      },
    );
    expect(verified.amountOut).toBe(87_169n);
    expect(verified.tokenInSpent).toBe(100_000n);

    expect(() =>
      verifySwapReceipt(
        {
          chainId: 5_042,
          status: 'success',
          from: USER,
          to: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
          input: plan.swap.data,
          value: plan.swap.value.toString(),
          logs: [
            transferLog(
              ARC_MAINNET_UNISWAP_V4_USDC,
              ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
              ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
              100_000n,
            ),
            transferLog(
              ARC_MAINNET_UNISWAP_V4_EURC,
              ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
              USER,
              87_169n,
            ),
          ],
        },
        {
          walletAddress: USER,
          recipient: USER,
          tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
          tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
          amountIn: 100_000n,
          minAmountOut: plan.quote.minAmountOut,
          transactionData: plan.swap.data,
          transactionValue: plan.swap.value,
          zeroForOne: true,
        },
      ),
    ).toThrow(/PoolManager swap evidence/);
  });

  it('verifies the EURC-to-USDC Permit2 direction and actual output', () => {
    const reverse = request({
      tokenInAddress: ARC_MAINNET_UNISWAP_V4_EURC,
      tokenOutAddress: ARC_MAINNET_UNISWAP_V4_USDC,
      amountIn: 87_169n,
    });
    const plan = buildUserControlledSwapPlan(
      reverse,
      observation(reverse, { amountOut: '99899', gasEstimate: '36933' }),
    );
    const transactionData = encodePermit2PermitAndSwap({
      quote: plan.quote,
      recipient: USER,
      deadline: plan.deadline,
      nonce: 0,
      signature: `0x${'11'.repeat(65)}`,
    });
    const verified = verifySwapReceipt(
      {
        chainId: 5_042,
        status: 'success',
        from: USER,
        to: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
        input: transactionData,
        value: '0',
        logs: [
          swapLog(99_899n, -87_169n),
          transferLog(
            ARC_MAINNET_UNISWAP_V4_EURC,
            USER,
            ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
            87_169n,
          ),
          transferLog(
            ARC_MAINNET_UNISWAP_V4_USDC,
            ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
            USER,
            99_899n,
          ),
        ],
      },
      {
        walletAddress: USER,
        recipient: USER,
        tokenIn: ARC_MAINNET_UNISWAP_V4_EURC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_USDC,
        amountIn: 87_169n,
        minAmountOut: plan.quote.minAmountOut,
        transactionData,
        transactionValue: 0n,
        zeroForOne: false,
      },
    );
    expect(verified).toEqual({ amountOut: 99_899n, tokenInSpent: 87_169n });
  });

  it.each([
    ['wrong chain', { chainId: 5_042_002 }],
    ['wrong router', { to: USER }],
    ['reverted', { status: 'reverted' as const }],
  ])('rejects a %s receipt', (_label, overrides) => {
    expect(() =>
      verifySwapReceipt(
        {
          chainId: 5_042,
          status: 'success',
          from: USER,
          to: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
          input: '0x1234',
          value: '0',
          logs: [],
          ...overrides,
        },
        {
          walletAddress: USER,
          recipient: USER,
          tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
          tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
          amountIn: 1_000_000n,
          minAmountOut: 1n,
          transactionData: '0x1234',
          transactionValue: 0n,
          zeroForOne: true,
        },
      ),
    ).toThrow(/Receipt|receipt/);
  });
});
