import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { BackendArcNetworkConfiguration } from '../config/arc-network.config';
import {
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_POOL_KEY,
  ARC_MAINNET_UNISWAP_V4_QUOTER,
  WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
  decodeQuoteExactInputSingleResult,
  encodeQuoteExactInputSingle,
  validateQuoteObservation,
  type MainnetUniswapV4QuoteObservation,
  type MainnetUniswapV4ValidatedQuote,
} from './mainnet-uniswap-v4-protocol';
import type { NormalizedMainnetUniswapV4BoundaryRequest } from './mainnet-uniswap-v4-readiness.service';
import { ARC_MAINNET_UNISWAP_V4_ERROR_CODES } from './mainnet-uniswap-v4-readiness.service';

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);

const EXECUTOR_ABI = parseAbi([
  'function paused() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function universalRouter() view returns (address)',
  'function permit2() view returns (address)',
  'function USDC() view returns (address)',
  'function EURC() view returns (address)',
]);

const PAYROLL_ABI = parseAbi([
  'function feeBps() view returns (uint256)',
  'function paused() view returns (bool)',
]);

const PAYROLL_CONTRACT = '0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34' as const;

const EXPECTED_UNIVERSAL_ROUTER =
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1' as const;
const EXPECTED_PERMIT2 =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
const EXPECTED_USDC =
  '0x3600000000000000000000000000000000000000' as const;
const EXPECTED_EURC =
  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' as const;

// Second independent Arc Mainnet RPC for quorum. Primary is the configured
// rpcUrl (https://rpc.mainnet.arc.io). Both are official production
// endpoints; static pool state must agree on both before any quote.
const QUORUM_RPC_URL = 'https://rpc.quicknode.mainnet.arc.io';

export const QUOTE_EXPIRY_SECONDS = 60;
export const QUOTE_MAX_BLOCK_AGE = 60;
const QUORUM_CACHE_MS = 30_000;

export type LiveQuoteResult = Readonly<{
  observation: MainnetUniswapV4QuoteObservation;
  validated: MainnetUniswapV4ValidatedQuote;
  quotedAt: string;
  expiresAt: string;
  expiresAtBlock: number;
}>;

function fail(reason: string): never {
  throw new ServiceUnavailableException({
    code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.UNAVAILABLE,
    message: reason,
  });
}

@Injectable()
export class MainnetUniswapV4QuoteService {
  private readonly network: BackendArcNetworkConfiguration;
  private quorumCache: { at: number; digest: string } | null = null;

  constructor(config: ConfigService) {
    this.network =
      config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
  }

  private rpcUrls(): string[] {
    const urls = [this.network.rpcUrl, QUORUM_RPC_URL].map((url) =>
      url.replace(/\/$/, ''),
    );
    return [...new Set(urls)];
  }

  private client(rpcUrl: string): PublicClient {
    return createPublicClient({
      chain: {
        id: this.network.chainId,
        name: this.network.key,
        nativeCurrency: { decimals: 18, name: 'USDC', symbol: 'USDC' },
        rpcUrls: { default: { http: [rpcUrl] } },
      },
      transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }),
    });
  }

  private async snapshotRpc(rpcUrl: string) {
    const client = this.client(rpcUrl);
    const stateView = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
    const executor = getAddress(WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS);
    const poolId = ARC_MAINNET_UNISWAP_V4_POOL_ID as Hex;
    // Sequential reads with a small pause: bursts of parallel eth_calls
    // trigger RPC 429s, which would false-fail the quorum gate.
    const chainId = await client.getChainId();
    const slot0 = await client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId],
    });
    const liquidity = await client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [poolId],
    });
    const paused = await client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: 'paused',
    });
    const feeBps = await client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: 'feeBps',
    });
    const router = await client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: 'universalRouter',
    });
    const permit2 = await client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: 'permit2',
    });
    const usdc = await client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: 'USDC',
    });
    const eurc = await client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: 'EURC',
    });
    return {
      chainId,
      tick: slot0[1].toString(),
      lpFee: slot0[3].toString(),
      liquidity: liquidity.toString(),
      paused,
      feeBps: feeBps.toString(),
      router: getAddress(router),
      permit2: getAddress(permit2),
      usdc: getAddress(usdc),
      eurc: getAddress(eurc),
    };
  }

  /**
   * Quorum digest over slow-moving configuration only. Pool tick and raw
   * liquidity move with every swap/mint, so requiring exact equality there
   * would false-fail on two healthy RPCs at slightly different heads.
   * Liveness (initialized pool, positive liquidity) is asserted per RPC.
   */
  private static quorumDigest(snapshot: {
    chainId: number;
    lpFee: string;
    paused: boolean;
    feeBps: string;
    router: string;
    permit2: string;
    usdc: string;
    eurc: string;
  }): string {
    return JSON.stringify(snapshot);
  }

  /**
   * Live static verification with two-RPC quorum: chain id, pool slot0
   * initialized with the expected lpFee, pool liquidity, executor paused
   * state and immutable config. Read-only. Fails closed on any mismatch,
   * RPC error, or quorum disagreement.
   */
  async assertLiveStaticQuorum(): Promise<void> {
    const now = Date.now();
    // Cache successful quorum briefly so quote/prepare/verify bursts do not
    // hammer both RPCs (which itself causes 429s and false fail-closed).
    // Only successes are cached; every failure re-checks live.
    if (
      this.quorumCache &&
      now - this.quorumCache.at < QUORUM_CACHE_MS
    ) {
      return;
    }
    const urls = this.rpcUrls();
    if (urls.length < 2) {
      fail(
        'Arc Mainnet RPC quorum is unavailable: two independent RPC endpoints are required.',
      );
    }
    try {
      // Sequential across RPCs to stay under rate limits; fail closed slow
      // rather than fast-and-wrong.
      const snapshots: Awaited<
        ReturnType<MainnetUniswapV4QuoteService['snapshotRpc']>
      >[] = [];
      for (const rpcUrl of urls) {
        snapshots.push(await this.snapshotRpc(rpcUrl));
      }
      const digests = snapshots.map((snapshot) =>
        MainnetUniswapV4QuoteService.quorumDigest({
          chainId: snapshot.chainId,
          lpFee: snapshot.lpFee,
          paused: snapshot.paused,
          feeBps: snapshot.feeBps,
          router: snapshot.router,
          permit2: snapshot.permit2,
          usdc: snapshot.usdc,
          eurc: snapshot.eurc,
        }),
      );
      if (new Set(digests).size !== 1) {
        fail(
          'Arc Mainnet RPC quorum disagrees on pool/executor state. Swaps stay disabled.',
        );
      }
      const snapshot = snapshots[0];
      if (snapshot.chainId !== 5_042) {
        fail('Quorum RPC chain id is not Arc Mainnet (5042).');
      }
      if (snapshot.lpFee !== '500') {
        fail('Canonical USDC/EURC pool fee is not 500 on Arc Mainnet.');
      }
      for (const [index, candidate] of snapshots.entries()) {
        if (BigInt(candidate.liquidity) <= 0n) {
          fail(
            `Canonical USDC/EURC pool has no liquidity on Arc Mainnet RPC ${index}. Swaps stay disabled.`,
          );
        }
      }
      if (snapshot.paused !== false) {
        fail('WizPaySwapExecutorMainnet is paused on Arc Mainnet.');
      }
      if (
        !isAddressEqual(snapshot.router, getAddress(EXPECTED_UNIVERSAL_ROUTER)) ||
        !isAddressEqual(snapshot.permit2, getAddress(EXPECTED_PERMIT2)) ||
        !isAddressEqual(snapshot.usdc, getAddress(EXPECTED_USDC)) ||
        !isAddressEqual(snapshot.eurc, getAddress(EXPECTED_EURC))
      ) {
        fail(
          'WizPaySwapExecutorMainnet configuration does not match the official Arc Mainnet deployment.',
        );
      }
      this.quorumCache = { at: now, digest: digests[0] };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'response' in error &&
        (error as { response?: unknown }).response &&
        typeof (error as { response?: unknown }).response === 'object' &&
        'code' in
          ((error as { response?: unknown }).response as Record<string, unknown>)
      ) {
        throw error;
      }
      fail(
        'Arc Mainnet RPC quorum is unreachable. Swaps stay disabled until both RPC endpoints agree.',
      );
    }
  }

  /**
   * Deterministic live exact-in quote from the official Uniswap V4 Quoter on
   * Arc Mainnet. Read-only eth_call against the verified pool key. Fails
   * closed on RPC error, quoter revert (no liquidity), or zero output.
   */
  async liveQuote(
    request: NormalizedMainnetUniswapV4BoundaryRequest,
  ): Promise<LiveQuoteResult> {
    await this.assertLiveStaticQuorum();
    const client = this.client(this.rpcUrls()[0]);
    const calldata = encodeQuoteExactInputSingle({
      tokenIn: request.tokenInAddress,
      tokenOut: request.tokenOutAddress,
      amountIn: request.amountIn,
    });
    let blockNumber: bigint;
    let returnData: Hex;
    try {
      blockNumber = await client.getBlockNumber();
      returnData = (await client.request({
        method: 'eth_call',
        params: [
          {
            to: ARC_MAINNET_UNISWAP_V4_QUOTER,
            data: calldata,
          },
          `0x${blockNumber.toString(16)}`,
        ],
      })) as Hex;
    } catch {
      fail(
        'Arc Mainnet quoter is unreachable or the pool has no liquidity for this input. Swaps stay disabled.',
      );
    }
    let decoded: { amountOut: bigint; gasEstimate: bigint };
    try {
      decoded = decodeQuoteExactInputSingleResult(returnData!);
    } catch {
      fail('Arc Mainnet quoter returned an undecodable quote.');
    }
    const observation: MainnetUniswapV4QuoteObservation = Object.freeze({
      chainId: 5_042,
      quoterAddress: ARC_MAINNET_UNISWAP_V4_QUOTER,
      poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
      tokenInAddress: request.tokenInAddress,
      tokenOutAddress: request.tokenOutAddress,
      amountIn: request.amountIn.toString(),
      blockNumber: Number(blockNumber!),
      amountOut: decoded!.amountOut.toString(),
      gasEstimate: decoded!.gasEstimate.toString(),
    });
    const validated = validateQuoteObservation(request, observation);
    const quotedAt = new Date().toISOString();
    return Object.freeze({
      observation,
      validated,
      quotedAt,
      expiresAt: new Date(Date.now() + QUOTE_EXPIRY_SECONDS * 1_000).toISOString(),
      expiresAtBlock: Number(blockNumber!) + QUOTE_MAX_BLOCK_AGE,
    });
  }

  /**
   * Reject stale quotes at prepare/verify time: the pinned block must be
   * within QUOTE_MAX_BLOCK_AGE of the live head. Read-only.
   */
  async assertQuoteFresh(
    observation: Pick<MainnetUniswapV4QuoteObservation, 'blockNumber'>,
  ): Promise<void> {
    const client = this.client(this.rpcUrls()[0]);
    let head: bigint;
    try {
      head = await client.getBlockNumber();
    } catch {
      fail('Arc Mainnet head block is unreachable; stale quotes stay rejected.');
    }
    if (Number(head!) - observation.blockNumber > QUOTE_MAX_BLOCK_AGE) {
      fail(
        `Quote block ${observation.blockNumber} is stale at head ${head!.toString()}. Obtain a new quote.`,
      );
    }
  }

  /**
   * Live WizPayPayrollMainnet feeBps (immutable on-chain; verified 25).
   * Read-only. Fails closed when unreadable so funding math never assumes.
   */
  async payrollFeeBps(): Promise<bigint> {
    const client = this.client(this.rpcUrls()[0]);
    try {
      return (await client.readContract({
        address: getAddress(PAYROLL_CONTRACT),
        abi: PAYROLL_ABI,
        functionName: 'feeBps',
      })) as bigint;
    } catch {
      fail('Payroll fee is unreadable on Arc Mainnet.');
    }
  }

  /** Canonical pool id derived from the pinned pool key (uniqueness anchor). */
  static derivedPoolId(): Hex {
    return keccak256(
      encodeAbiParameters(
        [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
        ],
        [ARC_MAINNET_UNISWAP_V4_POOL_KEY],
      ),
    );
  }

  static executorAddress(): Address {
    return getAddress(WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS);
  }
}
