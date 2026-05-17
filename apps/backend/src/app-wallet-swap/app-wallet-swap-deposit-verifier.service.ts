import { Injectable } from '@nestjs/common';
import {
  createPublicClient,
  decodeEventLog,
  http,
  isAddressEqual,
  parseAbiItem,
  type Address,
} from 'viem';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import {
  AppWalletSwapDepositVerificationRequest,
  AppWalletSwapDepositVerificationResult,
} from './app-wallet-swap.types';

const ARC_TESTNET_CHAIN_ID = 5_042_002;
const DEFAULT_ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.network';
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const ARC_NATIVE_USDC_LOG_ADDRESS =
  '0x1800000000000000000000000000000000000000' as Address;
const ARC_NATIVE_USDC_TRANSFER_TOPIC =
  '0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22';
const ARC_NATIVE_USDC_DECIMAL_SCALE = 1_000_000_000_000n;
const TOKEN_ADDRESS_BY_SYMBOL = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
} as const;

function readArcRpcUrl() {
  const configured =
    process.env.ARC_TESTNET_RPC_URL ??
    process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ??
    process.env.ARC_TESTNET_RPC_URLS?.split(/[\s,]+/)[0] ??
    process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URLS?.split(/[\s,]+/)[0];

  return configured?.trim() || DEFAULT_ARC_TESTNET_RPC_URL;
}

@Injectable()
export class AppWalletSwapDepositVerifierService {
  private readonly publicClient = createPublicClient({
    chain: {
      id: ARC_TESTNET_CHAIN_ID,
      name: 'Arc Testnet',
      nativeCurrency: {
        decimals: 18,
        name: 'USDC',
        symbol: 'USDC',
      },
      rpcUrls: {
        default: { http: [readArcRpcUrl()] },
      },
    },
    transport: http(readArcRpcUrl()),
  });

  async verifyDeposit(
    request: AppWalletSwapDepositVerificationRequest,
  ): Promise<AppWalletSwapDepositVerificationResult> {
    const receipt = await this.publicClient.getTransactionReceipt({
      hash: request.depositTxHash as `0x${string}`,
    });

    if (receipt.status !== 'success') {
      return {
        confirmed: false,
        error: 'Deposit transaction receipt is not successful.',
      };
    }

    const expectedAmount = BigInt(request.amountIn);
    const treasuryAddress = request.treasuryDepositAddress as Address;
    const userWalletAddress = request.userWalletAddress as Address;
    const tokenAddress = TOKEN_ADDRESS_BY_SYMBOL[request.tokenIn] as Address;

    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, tokenAddress)) {
        continue;
      }

      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== 'Transfer') {
          continue;
        }

        const { from, to, value } = decoded.args;

        if (
          isAddressEqual(from, userWalletAddress) &&
          isAddressEqual(to, treasuryAddress) &&
          value >= expectedAmount
        ) {
          return {
            confirmed: true,
            confirmedAmount: value.toString(),
          };
        }
      } catch {
        continue;
      }
    }

    if (request.tokenIn === 'USDC') {
      const expectedNativeAmount =
        expectedAmount * ARC_NATIVE_USDC_DECIMAL_SCALE;

      for (const log of receipt.logs) {
        if (!isAddressEqual(log.address, ARC_NATIVE_USDC_LOG_ADDRESS)) {
          continue;
        }

        if (
          log.topics[0]?.toLowerCase() !==
          ARC_NATIVE_USDC_TRANSFER_TOPIC.toLowerCase()
        ) {
          continue;
        }

        const from = this.addressFromTopic(log.topics[1]);
        const to = this.addressFromTopic(log.topics[2]);

        if (
          !from ||
          !to ||
          !isAddressEqual(from, userWalletAddress) ||
          !isAddressEqual(to, treasuryAddress)
        ) {
          continue;
        }

        if (BigInt(log.data) >= expectedNativeAmount) {
          return {
            confirmed: true,
            confirmedAmount: request.amountIn,
          };
        }
      }
    }

    return {
      confirmed: false,
      error:
        `Deposit transaction did not include a matching ${request.tokenIn} transfer to the treasury.`,
    };
  }

  private addressFromTopic(topic: `0x${string}` | undefined): Address | null {
    if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
      return null;
    }

    return `0x${topic.slice(-40)}` as Address;
  }
}
