import { encodeEventTopics, type Address, type Hex } from 'viem';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';

const TREASURY_ADDRESS =
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b' as Address;
const USER_ADDRESS = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147' as Address;
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const TX_HASH =
  '0xdd019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5' as Hex;

describe('AppWalletSwapTreasuryVerifierService', () => {
  let getTransactionReceipt: jest.Mock;
  let service: AppWalletSwapTreasuryVerifierService;

  beforeEach(() => {
    getTransactionReceipt = jest.fn();
    service = new AppWalletSwapTreasuryVerifierService();
    (
      service as unknown as {
        publicClient: { getTransactionReceipt: jest.Mock };
      }
    ).publicClient = { getTransactionReceipt };
  });

  it('sums matching treasury output transfers and preserves base units', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt([
        transferLog(
          USER_SWAP_EURC_ADDRESS,
          OTHER_ADDRESS,
          TREASURY_ADDRESS,
          600n,
        ),
        transferLog(
          USER_SWAP_EURC_ADDRESS,
          OTHER_ADDRESS,
          TREASURY_ADDRESS,
          500n,
        ),
      ]),
    );

    await expect(
      service.verifyTreasurySwap({
        tokenOut: 'EURC',
        txHash: TX_HASH,
        treasuryAddress: TREASURY_ADDRESS,
        minimumOutput: '1000',
      }),
    ).resolves.toEqual({ confirmed: true, actualOutput: '1100' });
  });

  it('rejects an unsuccessful or below-minimum treasury swap receipt', async () => {
    getTransactionReceipt
      .mockResolvedValueOnce({ status: 'reverted', logs: [] })
      .mockResolvedValueOnce(
        receipt([
          transferLog(
            USER_SWAP_EURC_ADDRESS,
            OTHER_ADDRESS,
            TREASURY_ADDRESS,
            999n,
          ),
        ]),
      );

    await expect(
      service.verifyTreasurySwap({
        tokenOut: 'EURC',
        txHash: TX_HASH,
        treasuryAddress: TREASURY_ADDRESS,
        minimumOutput: '1000',
      }),
    ).resolves.toEqual({
      confirmed: false,
      error: 'Treasury swap transaction receipt is not successful.',
    });
    await expect(
      service.verifyTreasurySwap({
        tokenOut: 'EURC',
        txHash: TX_HASH,
        treasuryAddress: TREASURY_ADDRESS,
        minimumOutput: '1000',
      }),
    ).resolves.toEqual({
      confirmed: false,
      error: 'Treasury swap output is lower than the operation minimum output.',
    });
  });

  it('ignores wrong-token, wrong-recipient, and malformed treasury logs', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt([
        transferLog(
          USER_SWAP_USDC_ADDRESS,
          OTHER_ADDRESS,
          TREASURY_ADDRESS,
          1000n,
        ),
        transferLog(USER_SWAP_EURC_ADDRESS, OTHER_ADDRESS, USER_ADDRESS, 1000n),
        { address: USER_SWAP_EURC_ADDRESS, topics: [], data: '0x' },
      ]),
    );

    await expect(
      service.verifyTreasurySwap({
        tokenOut: 'EURC',
        txHash: TX_HASH,
        treasuryAddress: TREASURY_ADDRESS,
      }),
    ).resolves.toEqual({
      confirmed: false,
      error:
        'Treasury swap transaction did not include a matching EURC transfer to the treasury.',
    });
  });

  it('confirms payout only for the exact treasury-to-user token transfer', async () => {
    getTransactionReceipt.mockResolvedValueOnce(
      receipt([
        transferLog(
          USER_SWAP_USDC_ADDRESS,
          TREASURY_ADDRESS,
          USER_ADDRESS,
          1000n,
        ),
      ]),
    );

    await expect(
      service.verifyPayout({
        tokenOut: 'USDC',
        txHash: TX_HASH,
        treasuryAddress: TREASURY_ADDRESS,
        userWalletAddress: USER_ADDRESS,
        payoutAmount: '1000',
      }),
    ).resolves.toEqual({ confirmed: true });
  });

  it('rejects unsuccessful, insufficient, and directionally incorrect payouts', async () => {
    getTransactionReceipt
      .mockResolvedValueOnce({ status: 'reverted', logs: [] })
      .mockResolvedValueOnce(
        receipt([
          transferLog(
            USER_SWAP_USDC_ADDRESS,
            TREASURY_ADDRESS,
            USER_ADDRESS,
            999n,
          ),
          transferLog(
            USER_SWAP_USDC_ADDRESS,
            USER_ADDRESS,
            TREASURY_ADDRESS,
            1000n,
          ),
        ]),
      );

    await expect(
      service.verifyPayout({
        tokenOut: 'USDC',
        txHash: TX_HASH,
        treasuryAddress: TREASURY_ADDRESS,
        userWalletAddress: USER_ADDRESS,
        payoutAmount: '1000',
      }),
    ).resolves.toEqual({
      confirmed: false,
      error: 'Payout transaction receipt is not successful.',
    });
    await expect(
      service.verifyPayout({
        tokenOut: 'USDC',
        txHash: TX_HASH,
        treasuryAddress: TREASURY_ADDRESS,
        userWalletAddress: USER_ADDRESS,
        payoutAmount: '1000',
      }),
    ).resolves.toEqual({
      confirmed: false,
      error:
        'Payout transaction did not include a matching USDC transfer to the user wallet.',
    });
  });
});

function receipt(logs: unknown[]) {
  return { status: 'success', logs };
}

function transferLog(
  tokenAddress: string,
  from: Address,
  to: Address,
  value: bigint,
) {
  return {
    address: tokenAddress as Address,
    topics: encodeEventTopics({
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
    }),
    data: `0x${value.toString(16).padStart(64, '0')}` as Hex,
  };
}
