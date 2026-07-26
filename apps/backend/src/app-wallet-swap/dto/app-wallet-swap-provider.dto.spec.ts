import { validate } from 'class-validator';
import { AppWalletSwapOperationDto } from './app-wallet-swap-operation.dto';
import { AppWalletSwapQuoteDto } from './app-wallet-swap-quote.dto';

const baseRequest = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '1000000',
  fromAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
  chain: 'ARC-TESTNET',
};

function createDto<T extends AppWalletSwapQuoteDto>(
  Type: new () => T,
  provider?: unknown,
): T {
  return Object.assign(new Type(), baseRequest, {
    ...(provider === undefined ? {} : { provider }),
  });
}

describe.each([
  ['quote', AppWalletSwapQuoteDto],
  ['operation', AppWalletSwapOperationDto],
] as const)('App Wallet swap %s DTO provider validation', (_, Type) => {
  it.each(['stablefx', 'swapkit'] as const)(
    'accepts provider=%s',
    async (provider) => {
      await expect(validate(createDto(Type, provider))).resolves.toEqual([]);
    },
  );

  it('preserves backward compatibility when provider is omitted', async () => {
    await expect(validate(createDto(Type))).resolves.toEqual([]);
  });

  it.each(['xylonet', 'unknown-provider', 42, {}])(
    'rejects unsupported or malformed provider=%p',
    async (provider) => {
      const errors = await validate(createDto(Type, provider));

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'provider' }),
        ]),
      );
    },
  );

  it('keeps existing required-field validation intact', async () => {
    const dto = createDto(Type, 'swapkit');
    dto.amountIn = '';

    const errors = await validate(dto);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'amountIn' }),
      ]),
    );
  });
});
