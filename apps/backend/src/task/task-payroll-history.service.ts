import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlockchainService,
  type RpcLogResult,
} from '../adapters/blockchain.service';
import type {
  TaskEmployeeBreakdownItem,
  TaskPayrollHistoryEvent,
  TaskPayrollHistoryResponse,
} from './task.types';

const PAYROLL_CHAIN = 'ARC-TESTNET';
const PAYROLL_HISTORY_FROM_BLOCK = 35_790_000n;
const PAYROLL_HISTORY_CHUNK_SIZE = 9_999n;
const DEFAULT_WIZPAY_ADDRESS = '0x87ACE45582f45cC81AC1E627E875AE84cbd75946';
const LEGACY_WIZPAY_ADDRESS = '0xE89f7c3781Dd24baE53d6ef9Af8a6a174731b4c8';
const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
const EURC_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

@Injectable()
export class TaskPayrollHistoryService {
  constructor(
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService,
  ) {}

  async getWalletPayrollHistory(
    walletAddress?: string,
  ): Promise<TaskPayrollHistoryResponse> {
    const { decodeEventLog, encodeEventTopics, getAddress, parseAbiItem } =
      await import('viem');

    const normalizedWallet = this.normalizeWalletAddress(walletAddress, getAddress);
    const batchPaymentRoutedEvent = parseAbiItem(
      'event BatchPaymentRouted(address indexed sender, address tokenIn, address tokenOut, uint256 totalAmountIn, uint256 totalAmountOut, uint256 totalFees, uint256 recipientCount, string referenceId)',
    );
    const erc20TransferEvent = parseAbiItem(
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    );
    const historyAddresses = this.getHistoryAddresses(getAddress);
    const eventTopics = encodeEventTopics({
      abi: [batchPaymentRoutedEvent],
      eventName: 'BatchPaymentRouted',
      args: { sender: normalizedWallet as `0x${string}` },
    });

    const currentBlock = await this.blockchainService.getBlockNumberOnChain(
      PAYROLL_CHAIN,
    );
    const rawLogs = await this.fetchPayrollLogs(historyAddresses, eventTopics, currentBlock);
    const blockTimestamps = await this.resolveBlockTimestamps(rawLogs);

    const events: TaskPayrollHistoryEvent[] = [];
    const employeePayments: TaskEmployeeBreakdownItem[] = [];

    for (const log of rawLogs) {
      if (!log.transactionHash || !log.blockNumber) {
        continue;
      }

      const decodedLog = decodeEventLog({
        abi: [batchPaymentRoutedEvent],
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const args = decodedLog.args as {
        tokenIn: `0x${string}`;
        tokenOut: `0x${string}`;
        totalAmountIn: bigint;
        totalAmountOut: bigint;
        totalFees: bigint;
        recipientCount: bigint;
        referenceId: string;
      };
      const blockNumber = BigInt(log.blockNumber);
      const timestampMs = blockTimestamps.get(log.blockNumber) ?? 0;

      events.push({
        txHash: log.transactionHash,
        blockNumber: blockNumber.toString(),
        timestampMs,
        tokenIn: getAddress(args.tokenIn),
        tokenOut: getAddress(args.tokenOut),
        totalAmountIn: args.totalAmountIn.toString(),
        totalAmountOut: args.totalAmountOut.toString(),
        totalFees: args.totalFees.toString(),
        recipientCount: Number(args.recipientCount),
        referenceId: args.referenceId,
      });

      const resolvedPayments = await this.resolveEmployeePaymentsForLog({
        decodeEventLog,
        erc20TransferEvent,
        getAddress,
        log,
        timestampMs,
        tokenIn: getAddress(args.tokenIn),
        totalAmountOut: args.totalAmountOut,
      });

      employeePayments.push(...resolvedPayments);
    }

    return {
      walletAddress: normalizedWallet,
      events: events.sort((left, right) =>
        BigInt(right.blockNumber) > BigInt(left.blockNumber) ? 1 : BigInt(right.blockNumber) < BigInt(left.blockNumber) ? -1 : 0,
      ),
      employeePayments: employeePayments.sort(
        (left, right) => right.date - left.date,
      ),
    };
  }

  private async fetchPayrollLogs(
    historyAddresses: string[],
    eventTopics: ReadonlyArray<string | string[] | null>,
    currentBlock: bigint,
  ): Promise<RpcLogResult[]> {
    const allLogs: RpcLogResult[] = [];
    let fromBlock = PAYROLL_HISTORY_FROM_BLOCK;

    while (fromBlock <= currentBlock) {
      let toBlock = fromBlock + PAYROLL_HISTORY_CHUNK_SIZE;
      if (toBlock > currentBlock) {
        toBlock = currentBlock;
      }

      const chunkLogs = await this.blockchainService.getLogsOnChain({
        address: historyAddresses,
        topics: [...eventTopics],
        fromBlock,
        toBlock,
        chain: PAYROLL_CHAIN,
      });

      allLogs.push(...chunkLogs);
      fromBlock = toBlock + 1n;
    }

    return allLogs;
  }

  private async resolveBlockTimestamps(rawLogs: RpcLogResult[]) {
    const blockNumbers = Array.from(
      new Set(
        rawLogs
          .map((log) => log.blockNumber)
          .filter((blockNumber): blockNumber is string => Boolean(blockNumber)),
      ),
    );
    const entries = await Promise.all(
      blockNumbers.map(async (blockNumber) => {
        const block = await this.blockchainService.getBlockOnChain(
          BigInt(blockNumber),
          PAYROLL_CHAIN,
        );

        return [blockNumber, Number(BigInt(block.timestamp)) * 1000] as const;
      }),
    );

    return new Map(entries);
  }

  private async resolveEmployeePaymentsForLog(input: {
    decodeEventLog: (value: {
      abi: readonly unknown[];
      data: `0x${string}`;
      topics: [`0x${string}`, ...`0x${string}`[]];
    }) => { args: unknown };
    erc20TransferEvent: unknown;
    getAddress: (address: string) => string;
    log: RpcLogResult;
    timestampMs: number;
    tokenIn: string;
    totalAmountOut: bigint;
  }): Promise<TaskEmployeeBreakdownItem[]> {
    const txHash = input.log.transactionHash;
    if (!txHash) {
      return [];
    }

    try {
      const receipt = await this.blockchainService.getTransactionReceiptOnChain(
        txHash,
        PAYROLL_CHAIN,
      );

      if (!receipt) {
        throw new Error(`Transaction receipt ${txHash} not found.`);
      }

      const contractAddress = input.log.address.toLowerCase();
      const payments = receipt.logs.flatMap((receiptLog) => {
        try {
          const decoded = input.decodeEventLog({
            abi: [input.erc20TransferEvent],
            data: receiptLog.data as `0x${string}`,
            topics: receiptLog.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          const args = decoded.args as {
            from: string;
            to: string;
            value: bigint;
          };

          if (args.from.toLowerCase() !== contractAddress) {
            return [];
          }

          const tokenInfo = this.resolveTokenInfo(receiptLog.address);

          return [
            {
              taskId: txHash,
              date: input.timestampMs,
              employee: input.getAddress(args.to),
              status: 'Confirmed' as const,
              amount: args.value.toString(),
              tokenSymbol: tokenInfo.symbol,
              tokenDecimals: tokenInfo.decimals,
              txHash,
            },
          ];
        } catch {
          return [];
        }
      });

      if (payments.length > 0) {
        return payments;
      }
    } catch {
      // Fall through to aggregate fallback below.
    }

    const tokenInfo = this.resolveTokenInfo(input.tokenIn);

    return [
      {
        taskId: txHash,
        date: input.timestampMs,
        employee: 'Multiple Recipients',
        status: 'Confirmed',
        amount: input.totalAmountOut.toString(),
        tokenSymbol: tokenInfo.symbol,
        tokenDecimals: tokenInfo.decimals,
        txHash,
      },
    ];
  }

  private getHistoryAddresses(getAddress: (address: string) => string): string[] {
    const configuredAddress =
      this.configService.get<string>('NEXT_PUBLIC_CONTRACT_ADDRESS')?.trim() ||
      this.configService.get<string>('NEXT_PUBLIC_WIZPAY_ADDRESS')?.trim() ||
      DEFAULT_WIZPAY_ADDRESS;

    return Array.from(
      new Set([configuredAddress, LEGACY_WIZPAY_ADDRESS].map((address) => getAddress(address))),
    );
  }

  private normalizeWalletAddress(
    walletAddress: string | undefined,
    getAddress: (address: string) => string,
  ): string {
    if (!walletAddress?.trim()) {
      throw new BadRequestException('Query parameter wallet is required.');
    }

    try {
      return getAddress(walletAddress.trim());
    } catch {
      throw new BadRequestException('Query parameter wallet must be a valid EVM address.');
    }
  }

  private resolveTokenInfo(tokenAddress: string) {
    const normalized = tokenAddress.trim().toLowerCase();

    if (normalized === USDC_ADDRESS.toLowerCase()) {
      return { symbol: 'USDC', decimals: 6 };
    }

    if (normalized === EURC_ADDRESS.toLowerCase()) {
      return { symbol: 'EURC', decimals: 6 };
    }

    return { symbol: '???', decimals: 6 };
  }
}