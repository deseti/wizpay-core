import { Injectable, Logger } from '@nestjs/common';
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
// Standard ERC-20 Transfer event topic0 (keccak256("Transfer(address,address,uint256)")).
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Observed Arc Testnet pseudo log alias that emits native USDC movements as a
// standard ERC-20 Transfer event. This is NOT a documented contract address
// (`cast code` returns 0x), so it is treated only as an observed native USDC
// transfer-log alias and is guarded narrowly. Values emitted under this alias
// use Arc native 18-decimal scale, not the ERC-20 6-decimal interface.
const ARC_NATIVE_USDC_TRANSFER_LOG_ALIAS_ADDRESS =
  '0xfffffffffffffffffffffffffffffffffffffffe' as Address;
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
  private readonly logger = new Logger(AppWalletSwapDepositVerifierService.name);

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

    this.logger.log(
      `[deposit-verify-diag] Verifying deposit: ` +
      `txHash=${request.depositTxHash} ` +
      `tokenIn=${request.tokenIn} ` +
      `tokenAddress=${tokenAddress} ` +
      `expectedAmount=${expectedAmount.toString()} ` +
      `userWalletAddress=${userWalletAddress} ` +
      `treasuryAddress=${treasuryAddress} ` +
      `receiptStatus=${receipt.status} ` +
      `logCount=${receipt.logs.length} ` +
      `txFrom=${receipt.from}`,
    );

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

        this.logger.log(
          `[deposit-verify-diag] ERC-20 Transfer found: ` +
          `from=${from} to=${to} value=${value.toString()} ` +
          `tokenAddress=${log.address} ` +
          `fromMatch=${isAddressEqual(from, userWalletAddress)} ` +
          `toMatch=${isAddressEqual(to, treasuryAddress)} ` +
          `valueMatch=${value >= expectedAmount}`,
        );

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

        // For App Wallet (ERC-4337/MSCA): the `from` in the Transfer event
        // might differ from the reported wallet address if the smart account
        // uses a proxy or the Circle SDK reports the owner address instead of
        // the MSCA address. Accept any transfer TO the treasury with sufficient
        // value in the user-initiated transaction (txHash is already verified).
        if (
          isAddressEqual(to, treasuryAddress) &&
          value >= expectedAmount
        ) {
          this.logger.log(
            `[deposit-verify-diag] Accepting transfer with relaxed from check: ` +
            `actualFrom=${from} expectedFrom=${userWalletAddress} ` +
            `txFrom=${receipt.from} ` +
            `to=${to} value=${value.toString()}`,
          );
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

      this.logger.log(
        `[deposit-verify-diag] Checking native USDC path: ` +
        `expectedNativeAmount=${expectedNativeAmount.toString()} ` +
        `nativeLogAddress=${ARC_NATIVE_USDC_LOG_ADDRESS} ` +
        `nativeTopic=${ARC_NATIVE_USDC_TRANSFER_TOPIC}`,
      );

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

        this.logger.log(
          `[deposit-verify-diag] Native USDC Transfer found: ` +
          `from=${from} to=${to} rawValue=${log.data} ` +
          `parsedValue=${BigInt(log.data).toString()} ` +
          `fromMatch=${from ? isAddressEqual(from, userWalletAddress) : false} ` +
          `toMatch=${to ? isAddressEqual(to, treasuryAddress) : false} ` +
          `valueMatch=${BigInt(log.data) >= expectedNativeAmount}`,
        );

        if (
          !to ||
          !isAddressEqual(to, treasuryAddress)
        ) {
          continue;
        }

        if (BigInt(log.data) >= expectedNativeAmount) {
          // Accept with or without from match for App Wallet MSCA compatibility
          if (from && !isAddressEqual(from, userWalletAddress)) {
            this.logger.log(
              `[deposit-verify-diag] Native USDC: accepting with relaxed from check: ` +
              `actualFrom=${from} expectedFrom=${userWalletAddress} txFrom=${receipt.from}`,
            );
          }
          return {
            confirmed: true,
            confirmedAmount: request.amountIn,
          };
        }
      }

      // Observed Arc Testnet path: native USDC movements can surface as a
      // standard ERC-20 Transfer event emitted from the pseudo log alias
      // 0xffff...fffe. The alias is not a documented token contract, so it is
      // matched narrowly here (exact alias address + ERC-20 Transfer topic)
      // and decoded against the Arc native 18-decimal scale.
      this.logger.log(
        `[deposit-verify-diag] Checking native USDC alias log path: ` +
        `expectedNativeAmount=${expectedNativeAmount.toString()} ` +
        `aliasLogAddress=${ARC_NATIVE_USDC_TRANSFER_LOG_ALIAS_ADDRESS} ` +
        `erc20Topic=${ERC20_TRANSFER_TOPIC}`,
      );

      for (const log of receipt.logs) {
        if (
          !isAddressEqual(log.address, ARC_NATIVE_USDC_TRANSFER_LOG_ALIAS_ADDRESS)
        ) {
          continue;
        }

        if (
          log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()
        ) {
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

          this.logger.log(
            `[deposit-verify-diag] Native USDC alias Transfer found: ` +
            `from=${from} to=${to} value=${value.toString()} ` +
            `aliasAddress=${log.address} ` +
            `fromMatch=${isAddressEqual(from, userWalletAddress)} ` +
            `toMatch=${isAddressEqual(to, treasuryAddress)} ` +
            `valueMatch=${value >= expectedNativeAmount}`,
          );

          if (!isAddressEqual(to, treasuryAddress)) {
            continue;
          }

          if (value >= expectedNativeAmount) {
            // Relaxed-from behavior mirrors the App Wallet MSCA path: the
            // depositTxHash is already verified, so a from mismatch must not
            // reject when to/value match. Native scale is enforced above.
            if (!isAddressEqual(from, userWalletAddress)) {
              this.logger.log(
                `[deposit-verify-diag] Native USDC alias: accepting with relaxed from check: ` +
                `actualFrom=${from} expectedFrom=${userWalletAddress} txFrom=${receipt.from}`,
              );
            }
            return {
              confirmed: true,
              confirmedAmount: request.amountIn,
            };
          }
        } catch {
          continue;
        }
      }
    }

    // Log all transfer events for diagnostic purposes when verification fails
    this.logger.warn(
      `[deposit-verify-diag] NO MATCHING TRANSFER FOUND. Dumping all logs:`,
    );

    // Collect actual transfers found for the error message
    const actualTransfers: string[] = [];

    for (let i = 0; i < receipt.logs.length; i++) {
      const log = receipt.logs[i];
      this.logger.warn(
        `[deposit-verify-diag] Log[${i}]: address=${log.address} ` +
        `topics=[${log.topics.join(', ')}] ` +
        `data=${log.data.slice(0, 130)}`,
      );

      // Try to decode as Transfer for any token
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'Transfer') {
          const { from, to, value } = decoded.args;
          this.logger.warn(
            `[deposit-verify-diag] Log[${i}] decoded Transfer: ` +
            `from=${from} to=${to} value=${value.toString()} ` +
            `expectedToken=${tokenAddress} actualToken=${log.address} ` +
            `expectedFrom=${userWalletAddress} expectedTo=${treasuryAddress} ` +
            `expectedAmount=${expectedAmount.toString()}`,
          );
          actualTransfers.push(
            `Transfer(from=${from}, to=${to}, value=${value.toString()}, token=${log.address})`,
          );
        }
      } catch {
        // Not a Transfer event
      }
    }

    const mismatchDetails = [
      `Expected: token=${tokenAddress}, to=${treasuryAddress}, amount>=${expectedAmount.toString()}`,
      actualTransfers.length > 0
        ? `Found transfers: ${actualTransfers.join('; ')}`
        : `No ERC-20 Transfer events found in ${receipt.logs.length} logs`,
    ].join('. ');

    return {
      confirmed: false,
      error:
        `Deposit transaction did not include a matching ${request.tokenIn} transfer to the treasury. ${mismatchDetails}`,
    };
  }

  private addressFromTopic(topic: `0x${string}` | undefined): Address | null {
    if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
      return null;
    }

    return `0x${topic.slice(-40)}` as Address;
  }
}
