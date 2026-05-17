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
  AppWalletSwapPayoutVerificationRequest,
  AppWalletSwapPayoutVerificationResult,
  AppWalletSwapTreasurySwapVerificationRequest,
  AppWalletSwapTreasurySwapVerificationResult,
} from './app-wallet-swap.types';

const ARC_TESTNET_CHAIN_ID = 5_042_002;
const DEFAULT_ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.network';
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
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
export class AppWalletSwapTreasuryVerifierService {
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

  async verifyTreasurySwap(
    request: AppWalletSwapTreasurySwapVerificationRequest,
  ): Promise<AppWalletSwapTreasurySwapVerificationResult> {
    const receipt = await this.publicClient.getTransactionReceipt({
      hash: request.txHash as `0x${string}`,
    });

    if (receipt.status !== 'success') {
      return {
        confirmed: false,
        error: 'Treasury swap transaction receipt is not successful.',
      };
    }

    const treasuryAddress = request.treasuryAddress as Address;
    const minimumOutput = request.minimumOutput
      ? BigInt(request.minimumOutput)
      : 0n;
    const tokenOutAddress = TOKEN_ADDRESS_BY_SYMBOL[request.tokenOut] as Address;
    let received = 0n;

    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, tokenOutAddress)) {
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

        const { to, value } = decoded.args;

        if (isAddressEqual(to, treasuryAddress)) {
          received += value;
        }
      } catch {
        continue;
      }
    }

    if (received <= 0n) {
      return {
        confirmed: false,
        error:
          `Treasury swap transaction did not include a matching ${request.tokenOut} transfer to the treasury.`,
      };
    }

    if (received < minimumOutput) {
      return {
        confirmed: false,
        error:
          'Treasury swap output is lower than the operation minimum output.',
      };
    }

    return {
      confirmed: true,
      actualOutput: received.toString(),
    };
  }

  async verifyPayout(
    request: AppWalletSwapPayoutVerificationRequest,
  ): Promise<AppWalletSwapPayoutVerificationResult> {
    const receipt = await this.publicClient.getTransactionReceipt({
      hash: request.txHash as `0x${string}`,
    });

    if (receipt.status !== 'success') {
      return {
        confirmed: false,
        error: 'Payout transaction receipt is not successful.',
      };
    }

    const treasuryAddress = request.treasuryAddress as Address;
    const userWalletAddress = request.userWalletAddress as Address;
    const expectedAmount = BigInt(request.payoutAmount);
    const tokenOutAddress = TOKEN_ADDRESS_BY_SYMBOL[request.tokenOut] as Address;

    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, tokenOutAddress)) {
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
          isAddressEqual(from, treasuryAddress) &&
          isAddressEqual(to, userWalletAddress) &&
          value >= expectedAmount
        ) {
          return { confirmed: true };
        }
      } catch {
        continue;
      }
    }

    return {
      confirmed: false,
      error:
        `Payout transaction did not include a matching ${request.tokenOut} transfer to the user wallet.`,
    };
  }
}
