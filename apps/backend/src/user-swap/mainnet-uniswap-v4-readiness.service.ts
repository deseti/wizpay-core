import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { getArcMainnetUniswapV4Readiness } from '@wizpay/arc-network';
import { getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';

export const ARC_MAINNET_UNISWAP_V4_ERROR_CODES = {
  INVALID_REQUEST: 'ARC_MAINNET_UNISWAP_V4_INVALID_REQUEST',
  UNAVAILABLE: 'ARC_MAINNET_UNISWAP_V4_UNAVAILABLE',
} as const;

export const ARC_MAINNET_UNISWAP_V4_CHAIN_ID = 5_042 as const;
export const ARC_MAINNET_UNISWAP_V4_MAX_SLIPPAGE_BPS = 500 as const;
export const ARC_MAINNET_UNISWAP_V4_MAX_DEADLINE_SECONDS = 1_200 as const;

export type MainnetUniswapV4WalletControl = 'external-wallet';

export type MainnetUniswapV4BoundaryRequest = Readonly<{
  chainId: unknown;
  tokenInAddress: unknown;
  tokenOutAddress: unknown;
  amountIn: unknown;
  recipient: unknown;
  walletAddress: unknown;
  walletControl: unknown;
  slippageBps: unknown;
  deadline: unknown;
}>;

export type NormalizedMainnetUniswapV4BoundaryRequest = Readonly<{
  chainId: 5_042;
  tokenInAddress: `0x${string}`;
  tokenOutAddress: `0x${string}`;
  amountIn: bigint;
  recipient: `0x${string}`;
  walletAddress: `0x${string}`;
  walletControl: MainnetUniswapV4WalletControl;
  slippageBps: number;
  deadline: number;
}>;

const OFFICIAL_TOKENS = [
  '0x3600000000000000000000000000000000000000',
  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
] as const;
const WALLET_CONTROLS = new Set<MainnetUniswapV4WalletControl>([
  'external-wallet',
]);
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT128_DECIMAL_DIGITS = MAX_UINT128.toString().length;

@Injectable()
export class MainnetUniswapV4ReadinessService {
  readonly readiness = getArcMainnetUniswapV4Readiness();

  validateBoundary(
    request: MainnetUniswapV4BoundaryRequest,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): NormalizedMainnetUniswapV4BoundaryRequest {
    if (request.chainId !== ARC_MAINNET_UNISWAP_V4_CHAIN_ID) {
      this.invalid('chainId must be Arc Mainnet (5042).');
    }
    const tokenInAddress = this.address(
      request.tokenInAddress,
      'tokenInAddress',
    );
    const tokenOutAddress = this.address(
      request.tokenOutAddress,
      'tokenOutAddress',
    );
    if (
      !OFFICIAL_TOKENS.some((token) => isAddressEqual(tokenInAddress, token)) ||
      !OFFICIAL_TOKENS.some((token) =>
        isAddressEqual(tokenOutAddress, token),
      ) ||
      isAddressEqual(tokenInAddress, tokenOutAddress)
    ) {
      this.invalid(
        'Only the official Arc Mainnet USDC/EURC pair is supported.',
      );
    }
    if (
      typeof request.amountIn !== 'string' ||
      request.amountIn.length > MAX_UINT128_DECIMAL_DIGITS ||
      !/^[1-9]\d*$/.test(request.amountIn)
    ) {
      this.invalid('amountIn must be a canonical positive integer string.');
    }
    const amountIn = BigInt(request.amountIn);
    if (amountIn > MAX_UINT128) {
      this.invalid('amountIn exceeds the Uniswap V4 uint128 swap limit.');
    }
    const walletAddress = this.address(request.walletAddress, 'walletAddress');
    const recipient = this.address(request.recipient, 'recipient');
    if (!isAddressEqual(walletAddress, recipient)) {
      this.invalid('recipient must equal the user-controlled wallet address.');
    }
    if (
      !WALLET_CONTROLS.has(
        request.walletControl as MainnetUniswapV4WalletControl,
      )
    ) {
      this.invalid('walletControl must be external-wallet.');
    }
    if (
      !Number.isInteger(request.slippageBps) ||
      (request.slippageBps as number) < 1 ||
      (request.slippageBps as number) > ARC_MAINNET_UNISWAP_V4_MAX_SLIPPAGE_BPS
    ) {
      this.invalid('slippageBps must be an integer between 1 and 500.');
    }
    if (
      !Number.isSafeInteger(request.deadline) ||
      (request.deadline as number) <= nowSeconds ||
      (request.deadline as number) >
        nowSeconds + ARC_MAINNET_UNISWAP_V4_MAX_DEADLINE_SECONDS
    ) {
      this.invalid('deadline must be in the next 1200 seconds.');
    }

    return Object.freeze({
      chainId: ARC_MAINNET_UNISWAP_V4_CHAIN_ID,
      tokenInAddress,
      tokenOutAddress,
      amountIn,
      recipient,
      walletAddress,
      walletControl: request.walletControl as MainnetUniswapV4WalletControl,
      slippageBps: request.slippageBps as number,
      deadline: request.deadline as number,
    });
  }

  private address(value: unknown, field: string): `0x${string}` {
    if (typeof value !== 'string' || !isAddress(value)) {
      this.invalid(`${field} must be a valid EVM address.`);
    }
    const address = getAddress(value);
    if (isAddressEqual(address, zeroAddress)) {
      this.invalid(`${field} must not be the zero address.`);
    }
    return address;
  }

  private invalid(message: string): never {
    throw new BadRequestException({
      code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
      message,
    });
  }
}
