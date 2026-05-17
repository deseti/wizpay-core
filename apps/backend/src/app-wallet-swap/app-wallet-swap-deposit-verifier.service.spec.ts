import { encodeEventTopics, type Address, type Hex } from 'viem';
import { USER_SWAP_USDC_ADDRESS } from '../user-swap/user-swap.service';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';

const USER_ADDRESS = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147' as Address;
const TREASURY_ADDRESS =
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b' as Address;
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const DEPOSIT_TX_HASH =
  '0xdd019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5' as Hex;
const ARC_NATIVE_USDC_LOG_ADDRESS =
  '0x1800000000000000000000000000000000000000' as Address;
const ARC_NATIVE_USDC_TRANSFER_TOPIC =
  '0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22' as Hex;
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;

const baseRequest = {
  amountIn: '5000000',
  depositTxHash: DEPOSIT_TX_HASH,
  tokenIn: 'USDC' as const,
  treasuryDepositAddress: TREASURY_ADDRESS,
  userWalletAddress: USER_ADDRESS,
};

describe('AppWalletSwapDepositVerifierService', () => {
  let getTransactionReceipt: jest.Mock;
  let service: AppWalletSwapDepositVerifierService;

  beforeEach(() => {
    getTransactionReceipt = jest.fn();
    service = new AppWalletSwapDepositVerifierService();
    (
      service as unknown as {
        publicClient: { getTransactionReceipt: jest.Mock };
      }
    ).publicClient = { getTransactionReceipt };
  });

  it('confirms an existing ERC-20 Transfer receipt path', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        logs: [
          {
            address: USER_SWAP_USDC_ADDRESS as Address,
            topics: erc20TransferTopics(USER_ADDRESS, TREASURY_ADDRESS),
            data: amountData(5_000_000n),
          },
        ],
      }),
    );

    const result = await service.verifyDeposit(baseRequest);

    expect(result).toEqual({
      confirmed: true,
      confirmedAmount: '5000000',
    });
  });

  it('confirms Arc native USDC receipt with the system log address', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        logs: [nativeUsdcLog()],
      }),
    );

    const result = await service.verifyDeposit(baseRequest);

    expect(result).toEqual({
      confirmed: true,
      confirmedAmount: baseRequest.amountIn,
    });
    expect(result).not.toHaveProperty('treasurySwapTxHash');
    expect(result).not.toHaveProperty('payoutTxHash');
    expect(result).not.toHaveProperty('settledAt');
  });

  it('confirms Arc native USDC receipt when account abstraction changes receipt from/to', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        from: OTHER_ADDRESS,
        to: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789' as Address,
        logs: [nativeUsdcLog()],
      }),
    );

    const result = await service.verifyDeposit(baseRequest);

    expect(result).toEqual({
      confirmed: true,
      confirmedAmount: baseRequest.amountIn,
    });
  });

  it('confirms amount 5e18 native units against operation amountIn 5000000', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        logs: [nativeUsdcLog({ data: amountData(5_000_000_000_000_000_000n) })],
      }),
    );

    const result = await service.verifyDeposit(baseRequest);

    expect(result).toMatchObject({
      confirmed: true,
      confirmedAmount: '5000000',
    });
  });

  it('rejects wrong native log from address', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        logs: [nativeUsdcLog({ from: OTHER_ADDRESS })],
      }),
    );

    await expectNativeReceiptToFail();
  });

  it('rejects wrong native log to address', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        logs: [nativeUsdcLog({ to: OTHER_ADDRESS })],
      }),
    );

    await expectNativeReceiptToFail();
  });

  it('rejects wrong native log topic0', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        logs: [
          nativeUsdcLog({
            topic0: ERC20_TRANSFER_TOPIC,
          }),
        ],
      }),
    );

    await expectNativeReceiptToFail();
  });

  it('rejects insufficient native amount', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt({
        logs: [nativeUsdcLog({ data: amountData(4_999_999_999_999_999_999n) })],
      }),
    );

    await expectNativeReceiptToFail();
  });

  async function expectNativeReceiptToFail() {
    await expect(service.verifyDeposit(baseRequest)).resolves.toEqual({
      confirmed: false,
      error:
        'Deposit transaction did not include a matching USDC transfer to the treasury.',
    });
  }
});

function receipt({
  from = USER_ADDRESS,
  to = TREASURY_ADDRESS,
  logs,
}: {
  from?: Address;
  to?: Address;
  logs: unknown[];
}) {
  return {
    status: 'success',
    from,
    to,
    logs,
  };
}

function nativeUsdcLog({
  from = USER_ADDRESS,
  to = TREASURY_ADDRESS,
  topic0 = ARC_NATIVE_USDC_TRANSFER_TOPIC,
  data = amountData(5_000_000_000_000_000_000n),
}: {
  from?: Address;
  to?: Address;
  topic0?: Hex;
  data?: Hex;
} = {}) {
  return {
    address: ARC_NATIVE_USDC_LOG_ADDRESS,
    topics: [topic0, addressTopic(from), addressTopic(to)],
    data,
  };
}

function erc20TransferTopics(from: Address, to: Address) {
  return encodeEventTopics({
    abi: [
      {
        type: 'event',
        name: 'Transfer',
        inputs: [
          { type: 'address', name: 'from', indexed: true },
          { type: 'address', name: 'to', indexed: true },
          { type: 'uint256', name: 'value', indexed: false },
        ],
      },
    ],
    eventName: 'Transfer',
    args: { from, to },
  });
}

function addressTopic(address: Address): Hex {
  return `0x${address.slice(2).padStart(64, '0')}` as Hex;
}

function amountData(amount: bigint): Hex {
  return `0x${amount.toString(16).padStart(64, '0')}` as Hex;
}
