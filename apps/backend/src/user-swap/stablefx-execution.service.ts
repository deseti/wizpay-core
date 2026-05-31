import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { recoverTypedDataAddress } from 'viem';
import { getStablefxSignDiagnostic } from '../modules/wallet/w3s-auth.service';
import {
  USER_SWAP_ALLOWED_CHAIN,
  USER_SWAP_API_BASE_URL,
  USER_SWAP_ERROR_CODES,
  USER_SWAP_STABLEFX_FUND_PATH,
  USER_SWAP_STABLEFX_FUNDING_PRESIGN_PATH,
  USER_SWAP_STABLEFX_QUOTE_PATH,
  USER_SWAP_STABLEFX_TRADES_PATH,
  type UserSwapToken,
} from './user-swap.types';

const STABLEFX_TOKEN_DECIMALS = 6;
const STABLEFX_SUPPORTED_PAIRS = new Set<string>(['USDC->EURC', 'EURC->USDC']);
const STABLEFX_TENOR = 'instant' as const;
const STABLEFX_TRADABLE_QUOTE_TYPE = 'tradable' as const;
const STABLEFX_QUOTE_EXPIRED_CODE = 3004;
const STABLEFX_AMOUNT_BELOW_MINIMUM_CODE = 3005;
const STABLEFX_SIGNATURE_ADDRESS_MISMATCH_CODE = 3015;
const REQUEST_TIMEOUT_MS = 30_000;
type StablefxExecutionStep =
  | 'tradable_quote'
  | 'create_trade'
  | 'funding_presign'
  | 'fund'
  | 'get_trade';

export interface StablefxTradableQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fromAddress: string;
  recipientAddress?: string;
  chain: string;
}

export interface StablefxCreateTradeRequest {
  idempotencyKey: string;
  quoteId: string;
  address: string;
  selectedAddress?: string;
  message: Record<string, unknown>;
  signature: string;
  tokenIn: string;
  tokenOut: string;
  walletMode: string;
}

export interface StablefxFundingPresignRequest {
  contractTradeId: string;
}

export interface StablefxFundRequest {
  signature: string;
  permit2: Record<string, unknown>;
}

@Injectable()
export class StablefxExecutionService {
  private readonly logger = new Logger(StablefxExecutionService.name);

  async createTradableQuote(
    request: StablefxTradableQuoteRequest,
  ): Promise<Record<string, unknown>> {
    this.guardExecutionConfig(request.chain);
    const tokenIn = this.normalizeToken(request.tokenIn);
    const tokenOut = this.normalizeToken(request.tokenOut);
    this.assertSupportedPair(tokenIn, tokenOut);

    const fromAddress = this.normalizeAddress(request.fromAddress);
    const recipientAddress = this.normalizeAddress(
      request.recipientAddress ?? fromAddress,
    );
    const fromAmountDecimal = this.baseUnitsToDecimalString(
      request.amountIn,
      STABLEFX_TOKEN_DECIMALS,
    );

    this.logger.log(
      `[user-swap-stablefx] tradable_quote request summary: ` +
        `provider=stablefx step=tradable_quote fromCurrency=${tokenIn} ` +
        `toCurrency=${tokenOut} amount=${fromAmountDecimal} ` +
        `recipientAddress=${recipientAddress}`,
    );

    const raw = await this.callStablefxApi(USER_SWAP_STABLEFX_QUOTE_PATH, {
      method: 'POST',
      step: 'tradable_quote',
      body: {
        from: {
          currency: tokenIn,
          amount: fromAmountDecimal,
        },
        to: {
          currency: tokenOut,
        },
        tenor: STABLEFX_TENOR,
        type: STABLEFX_TRADABLE_QUOTE_TYPE,
        recipientAddress,
      },
    });
    const quote = this.extractObject(raw, 'StableFX quote API');
    const typedData = quote.typedData;

    if (!this.isRecord(typedData) || !this.isRecord(typedData.message)) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_UNEXPECTED_RESPONSE,
        message:
          'StableFX tradable quote response did not include typedData.message.',
      });
    }

    this.logger.log(
      `[user-swap-stablefx] tradable_quote response summary: ` +
        `provider=stablefx step=tradable_quote shape=${JSON.stringify(
          this.sanitizeQuoteResponseShape(quote),
        )}`,
    );

    return quote;
  }

  async createTrade(
    request: StablefxCreateTradeRequest,
  ): Promise<Record<string, unknown>> {
    this.guardExecutionConfig();
    const tokenIn = this.normalizeToken(request.tokenIn);
    const tokenOut = this.normalizeToken(request.tokenOut);
    this.assertExecutionCapability(tokenIn, tokenOut, request.walletMode);
    this.assertUuid(request.idempotencyKey, 'idempotencyKey');
    const address = this.normalizeAddress(request.address);
    const selectedAddress = request.selectedAddress
      ? this.normalizeAddress(request.selectedAddress)
      : address;

    if (!request.quoteId.trim()) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'quoteId is required.',
      });
    }

    this.assertCreateTradeAddress(address, selectedAddress);
    this.assertSignature(request.signature);
    this.assertMessageAddressFields(request.message, address);
    await this.logAppWalletSignatureVerification({
      address,
      quoteId: request.quoteId.trim(),
      signature: request.signature,
    });

    this.logger.log(
      `[user-swap-stablefx] create_trade request summary: ` +
        `provider=stablefx step=create_trade quoteId=${request.quoteId.trim()} ` +
        `address=${address} messageFields=${JSON.stringify(
          this.collectMessageShapeFields(request.message),
        )}`,
    );

    const raw = await this.callStablefxApi(USER_SWAP_STABLEFX_TRADES_PATH, {
      method: 'POST',
      step: 'create_trade',
      body: {
        idempotencyKey: request.idempotencyKey,
        quoteId: request.quoteId.trim(),
        address,
        message: request.message,
        signature: request.signature,
      },
    });
    this.logTradeResponseShape('create_trade', raw);

    return this.normalizeTradeResponse(raw, 'StableFX create trade API');
  }

  async createFundingPresign(
    request: StablefxFundingPresignRequest,
  ): Promise<Record<string, unknown>> {
    this.guardExecutionConfig();
    const contractTradeId = request.contractTradeId.trim();

    if (!/^\d+$/.test(contractTradeId)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'contractTradeId must be a numeric string.',
      });
    }

    const presign = this.extractObject(
      await this.callStablefxApi(USER_SWAP_STABLEFX_FUNDING_PRESIGN_PATH, {
        method: 'POST',
        step: 'funding_presign',
        body: {
          contractTradeIds: [contractTradeId],
          type: 'taker',
        },
      }),
      'StableFX funding presign API',
    );

    const typedData = presign.typedData;

    if (!this.isRecord(typedData) || !this.isRecord(typedData.message)) {
      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_UNEXPECTED_RESPONSE,
        message:
          'StableFX funding presign response did not include typedData.message.',
      });
    }

    return presign;
  }

  async fund(request: StablefxFundRequest): Promise<Record<string, unknown>> {
    this.guardExecutionConfig();
    this.assertSignature(request.signature);

    const raw = await this.callStablefxApi(USER_SWAP_STABLEFX_FUND_PATH, {
      method: 'POST',
      step: 'fund',
      body: {
        type: 'taker',
        signature: request.signature,
        permit2: request.permit2,
      },
    });

    return this.isRecord(raw) ? raw : {};
  }

  async getTrade(tradeId: string): Promise<Record<string, unknown>> {
    this.guardExecutionConfig();
    this.assertUuid(tradeId, 'tradeId');

    const raw = await this.callStablefxApi(
      `${USER_SWAP_STABLEFX_TRADES_PATH}/${encodeURIComponent(tradeId)}`,
      { method: 'GET', step: 'get_trade' },
    );
    this.logTradeResponseShape('get_trade', raw);

    return this.normalizeTradeResponse(raw, 'StableFX get trade API');
  }

  private async logAppWalletSignatureVerification(input: {
    address: string;
    quoteId: string;
    signature: string;
  }): Promise<void> {
    const diagnostic = getStablefxSignDiagnostic({
      expectedSignerAddress: input.address,
      quoteId: input.quoteId,
    });

    if (!diagnostic) {
      return;
    }

    const signature = input.signature.trim();
    const signatureLength = signature.length;
    const signaturePrefix = signature.slice(0, 12);
    let recoveredAddress = 'unavailable';
    let recoveredMatchesExpected = false;
    let verificationError: string | null = null;

    try {
      const typedDataParams = diagnostic.typedData as unknown as Omit<
        Parameters<typeof recoverTypedDataAddress>[0],
        'signature'
      >;

      recoveredAddress = await recoverTypedDataAddress({
        ...typedDataParams,
        signature: signature as `0x${string}`,
      });
      recoveredMatchesExpected =
        recoveredAddress.toLowerCase() ===
        diagnostic.expectedSignerAddress.toLowerCase();
    } catch (error) {
      verificationError = this.getErrorMessage(error);
    }

    this.logger.log(
      `[stablefx-app-wallet-sign-verify] provider=stablefx step=verify_signature ` +
        `walletId=${diagnostic.walletId} ` +
        `expectedSignerAddress=${diagnostic.expectedSignerAddress} ` +
        `recoveredAddress=${recoveredAddress} ` +
        `recoveredMatchesExpected=${recoveredMatchesExpected} ` +
        `quoteId=${diagnostic.quoteId} ` +
        `fromCurrency=${diagnostic.fromCurrency} ` +
        `toCurrency=${diagnostic.toCurrency} ` +
        `amount=${diagnostic.amount} ` +
        `signatureLength=${signatureLength} ` +
        `signaturePrefix=${signaturePrefix}` +
        (verificationError ? ` verificationError=${verificationError}` : ''),
    );
  }

  private guardExecutionConfig(chain: string = USER_SWAP_ALLOWED_CHAIN): void {
    if (process.env.WIZPAY_USER_SWAP_ENABLED !== 'true') {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.DISABLED,
        message: 'User-wallet swap proxy is disabled.',
      });
    }

    if (chain !== USER_SWAP_ALLOWED_CHAIN) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.UNSUPPORTED_CHAIN,
        message: 'Only ARC-TESTNET is supported by StableFX execution.',
      });
    }

    if (process.env.WIZPAY_USER_SWAP_ALLOW_TESTNET !== 'true') {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.TESTNET_DISABLED,
        message: 'User-wallet swap on Arc Testnet is disabled.',
      });
    }

    if (process.env.WIZPAY_SWAP_PROVIDER?.trim().toLowerCase() !== 'stablefx') {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_EXECUTION_DISABLED,
        message:
          'StableFX execution is available only when WIZPAY_SWAP_PROVIDER=stablefx.',
      });
    }

    if (!this.getApiKey()) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_API_KEY_MISSING,
        message:
          'StableFX execution is selected but CIRCLE_STABLEFX_API_KEY is not configured.',
      });
    }
  }

  private async callStablefxApi(
    path: string,
    options: {
      method: 'GET' | 'POST';
      step: StablefxExecutionStep;
      body?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;

    try {
      response = await fetch(`${USER_SWAP_API_BASE_URL}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.getApiKey()}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error(
        `[user-swap-stablefx] Upstream request failed: ` +
          `provider=stablefx step=${options.step} method=${options.method} path=${path} ` +
          `error=${this.getErrorMessage(error)}`,
      );

      throw new BadGatewayException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_API_FAILED,
        message: `StableFX API request failed: ${this.getErrorMessage(error)}`,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const rawText = await response.text();
    const raw = this.parseJsonOrText(rawText);

    if (response.ok) {
      this.logger.log(
        `[user-swap-stablefx] Upstream OK response: ` +
          `provider=stablefx step=${options.step} method=${options.method} ` +
          `path=${path} upstreamStatus=${response.status}`,
      );
      return raw;
    }

    this.handleUpstreamError(
      options.method,
      options.step,
      path,
      response.status,
      raw,
    );
  }

  private handleUpstreamError(
    method: 'GET' | 'POST',
    step: StablefxExecutionStep,
    path: string,
    status: number,
    raw: unknown,
  ): never {
    const sanitizedError = this.sanitizeUpstreamError(raw);
    const upstreamCode = this.coerceCode(sanitizedError.code);

    this.logger.warn(
      `[user-swap-stablefx] Upstream non-OK response: ` +
        `provider=stablefx step=${step} method=${method} path=${path} ` +
        `upstreamStatus=${status} upstreamCode=${upstreamCode ?? 'none'} ` +
        `error=${JSON.stringify(sanitizedError)}`,
    );

    if (status === 401 || status === 403) {
      throw new ServiceUnavailableException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_AUTH_BLOCKED,
        message:
          'StableFX authentication or entitlement is missing. Execution is blocked.',
        details: sanitizedError,
      });
    }

    if (upstreamCode === STABLEFX_QUOTE_EXPIRED_CODE) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_QUOTE_EXPIRED,
        message:
          'StableFX quote expired before signing completed. Please retry.',
        details: sanitizedError,
      });
    }

    if (upstreamCode === STABLEFX_AMOUNT_BELOW_MINIMUM_CODE) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_AMOUNT_BELOW_MINIMUM,
        message: 'StableFX rejected the executable quote amount for this pair.',
        details: sanitizedError,
      });
    }

    if (upstreamCode === STABLEFX_SIGNATURE_ADDRESS_MISMATCH_CODE) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_ADDRESS_MISMATCH,
        message:
          'StableFX could not verify the signature against the create trade address.',
        details: sanitizedError,
      });
    }

    throw new BadGatewayException({
      code: USER_SWAP_ERROR_CODES.STABLEFX_API_FAILED,
      message: `StableFX API returned ${status}.`,
      details: sanitizedError,
    });
  }

  private normalizeTradeResponse(
    raw: unknown,
    source: string,
  ): Record<string, unknown> {
    const response = this.extractObject(raw, source);
    const nestedTrade = this.findTradeObject(response);
    const contractTradeId = this.resolveContractTradeId(raw);

    if (nestedTrade && nestedTrade !== response) {
      return {
        ...response,
        ...nestedTrade,
        ...(contractTradeId ? { contractTradeId } : {}),
      };
    }

    return {
      ...response,
      ...(contractTradeId ? { contractTradeId } : {}),
    };
  }

  private resolveContractTradeId(raw: unknown): string | null {
    const candidates = this.collectInterestingResponseFields(raw)
      .filter((field) => {
        const key = field.path.split('.').at(-1)?.toLowerCase() ?? '';
        const normalizedPath = field.path
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');

        return (
          normalizedPath.endsWith('contracttradeid') ||
          normalizedPath.endsWith('contractid') ||
          (key === 'id' &&
            normalizedPath.includes('contract') &&
            normalizedPath.includes('trade'))
        );
      })
      .map((field) => field.value)
      .filter(
        (value): value is string | number =>
          typeof value === 'string' || typeof value === 'number',
      );

    for (const candidate of candidates) {
      const value = String(candidate).trim();

      if (/^\d+$/.test(value)) {
        return value;
      }
    }

    return null;
  }

  private findTradeObject(value: unknown): Record<string, unknown> | null {
    if (!this.isRecord(value)) {
      return null;
    }

    if (
      typeof value.contractTradeId === 'string' ||
      typeof value.contractTradeId === 'number'
    ) {
      return value;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (!key.toLowerCase().includes('trade')) {
        continue;
      }

      if (this.isRecord(nested)) {
        return nested;
      }
    }

    for (const nested of Object.values(value)) {
      const found = this.findTradeObject(nested);

      if (found) {
        return found;
      }
    }

    return null;
  }

  private logTradeResponseShape(
    step: 'create_trade' | 'get_trade',
    raw: unknown,
  ): void {
    const shape = this.sanitizeTradeResponseShape(raw);

    this.logger.log(
      `[user-swap-stablefx] ${step} response shape: ` +
        `provider=stablefx step=${step} shape=${JSON.stringify(shape)}`,
    );
  }

  private sanitizeTradeResponseShape(raw: unknown): Record<string, unknown> {
    const rawRecord = this.isRecord(raw) ? raw : {};
    const data = this.isRecord(rawRecord.data) ? rawRecord.data : undefined;

    return {
      topLevelKeys: Object.keys(rawRecord).sort(),
      dataKeys: data ? Object.keys(data).sort() : [],
      interestingFields: this.collectInterestingResponseFields(raw),
      lifecycle: this.sanitizeTradeLifecycle(raw),
    };
  }

  private sanitizeQuoteResponseShape(raw: unknown): Record<string, unknown> {
    const rawRecord = this.isRecord(raw) ? raw : {};
    const typedData = this.isRecord(rawRecord.typedData)
      ? rawRecord.typedData
      : undefined;
    const typedDataDomain =
      typedData && this.isRecord(typedData.domain)
        ? typedData.domain
        : undefined;
    const typedDataMessage =
      typedData && this.isRecord(typedData.message)
        ? typedData.message
        : undefined;

    return {
      id: typeof rawRecord.id === 'string' ? rawRecord.id : undefined,
      fromCurrency: this.readStringPath(raw, ['from', 'currency']),
      fromAmount: this.readStringPath(raw, ['from', 'amount']),
      toCurrency: this.readStringPath(raw, ['to', 'currency']),
      toAmount: this.readStringPath(raw, ['to', 'amount']),
      typedDataChainId: typedDataDomain?.chainId,
      typedDataVerifyingContract: typedDataDomain?.verifyingContract,
      messageFields: this.collectMessageShapeFields(typedDataMessage),
    };
  }

  private sanitizeTradeLifecycle(raw: unknown): Record<string, unknown> {
    return {
      status:
        this.readStringPath(raw, ['data', 'status']) ??
        this.readStringPath(raw, ['status']),
      contractTradeId:
        this.readStringPath(raw, ['data', 'contractTradeId']) ??
        this.readStringPath(raw, ['contractTradeId']),
      recordTradeStatus: this.readStringPath(raw, [
        'data',
        'contractTransactions',
        'recordTrade',
        'status',
      ]),
      recordTradeTxHash:
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'txHash',
        ]) ??
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'transactionHash',
        ]) ??
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'hash',
        ]),
      recordTradeError:
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'errorDetails',
        ]) ??
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'error',
        ]) ??
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'errorMessage',
        ]) ??
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'revertReason',
        ]) ??
        this.readStringPath(raw, [
          'data',
          'contractTransactions',
          'recordTrade',
          'failureReason',
        ]),
      takerDeliverStatus: this.readStringPath(raw, [
        'data',
        'contractTransactions',
        'takerDeliver',
        'status',
      ]),
      makerDeliverStatus: this.readStringPath(raw, [
        'data',
        'contractTransactions',
        'makerDeliver',
        'status',
      ]),
    };
  }

  private collectMessageShapeFields(
    value: unknown,
    path = 'message',
  ): Array<{
    path: string;
    type: string;
    value?: string | number | boolean | null;
  }> {
    if (!this.isRecord(value) && !Array.isArray(value)) {
      return [];
    }

    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);

    return entries.flatMap(([key, nested]) => {
      const nextPath = `${path}.${key}`;
      const nestedFields = this.collectMessageShapeFields(nested, nextPath);
      const sensitiveKey = key.toLowerCase().includes('signature');

      if (sensitiveKey) {
        return nestedFields;
      }

      return [
        {
          path: nextPath,
          type: this.getValueType(nested),
          ...(this.isSafePrimitive(nested) ? { value: nested } : {}),
        },
        ...nestedFields,
      ];
    });
  }

  private collectInterestingResponseFields(
    value: unknown,
    path = '',
  ): Array<{
    path: string;
    type: string;
    value?: string | number | boolean | null;
  }> {
    if (!this.isRecord(value) && !Array.isArray(value)) {
      return [];
    }

    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);

    return entries.flatMap(([key, nested]) => {
      const nextPath = path ? `${path}.${key}` : key;
      const normalizedKey = key.toLowerCase();
      const sensitiveKey =
        normalizedKey.includes('signature') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('authorization') ||
        normalizedKey.includes('apikey') ||
        normalizedKey === 'token';
      const interestingKey =
        normalizedKey.includes('trade') ||
        normalizedKey.includes('contract') ||
        normalizedKey.includes('id') ||
        normalizedKey.includes('status') ||
        normalizedKey.includes('hash') ||
        normalizedKey.includes('error') ||
        normalizedKey.includes('revert') ||
        normalizedKey.includes('reason');
      const nestedFields = this.collectInterestingResponseFields(
        nested,
        nextPath,
      );

      if (!interestingKey || sensitiveKey) {
        return nestedFields;
      }

      return [
        {
          path: nextPath,
          type: this.getValueType(nested),
          ...(this.isSafePrimitive(nested) ? { value: nested } : {}),
        },
        ...nestedFields,
      ];
    });
  }

  private getValueType(value: unknown): string {
    if (Array.isArray(value)) {
      return 'array';
    }

    if (value === null) {
      return 'null';
    }

    return typeof value;
  }

  private readStringPath(value: unknown, path: string[]): string | undefined {
    let current = value;

    for (const key of path) {
      if (!this.isRecord(current)) {
        return undefined;
      }

      current = current[key];
    }

    return typeof current === 'string' || typeof current === 'number'
      ? String(current)
      : undefined;
  }

  private isSafePrimitive(
    value: unknown,
  ): value is string | number | boolean | null {
    return (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    );
  }

  private normalizeToken(value: string): UserSwapToken {
    const normalized = value?.trim().toUpperCase();

    if (normalized !== 'USDC' && normalized !== 'EURC') {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'Only USDC and EURC are supported for StableFX execution.',
      });
    }

    return normalized;
  }

  private assertSupportedPair(
    tokenIn: UserSwapToken,
    tokenOut: UserSwapToken,
  ): void {
    if (!STABLEFX_SUPPORTED_PAIRS.has(`${tokenIn}->${tokenOut}`)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_UNSUPPORTED_PAIR,
        message: 'StableFX execution supports only USDC->EURC and EURC->USDC.',
      });
    }
  }

  private assertExecutionCapability(
    tokenIn: UserSwapToken,
    tokenOut: UserSwapToken,
    walletMode: string,
  ): void {
    this.assertSupportedPair(tokenIn, tokenOut);

    const normalizedWalletMode = walletMode?.trim().toLowerCase();

    if (
      normalizedWalletMode !== 'external' &&
      normalizedWalletMode !== 'circle' &&
      normalizedWalletMode !== 'app'
    ) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'StableFX execution requires external or App Wallet mode.',
      });
    }
  }

  private normalizeAddress(value: string): string {
    const trimmed = value?.trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed ?? '')) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'StableFX execution requires a valid EVM wallet address.',
      });
    }

    return trimmed;
  }

  private assertUuid(value: string, fieldName: string): void {
    if (
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value?.trim() ?? '',
      )
    ) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: `${fieldName} must be a UUID string.`,
      });
    }
  }

  private assertSignature(value: string): void {
    if (!/^0x[a-fA-F0-9]+$/.test(value?.trim() ?? '')) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'StableFX execution requires a 0x-prefixed signature.',
      });
    }
  }

  private assertCreateTradeAddress(
    createTradeAddress: string,
    selectedAddress: string,
  ): void {
    if (createTradeAddress.toLowerCase() === selectedAddress.toLowerCase()) {
      return;
    }

    this.logger.warn(
      `[user-swap-stablefx] Local address validation failed: ` +
        `provider=stablefx step=create_trade selectedAddress=${selectedAddress} ` +
        `createTradeAddress=${createTradeAddress}`,
    );

    throw new BadRequestException({
      code: USER_SWAP_ERROR_CODES.STABLEFX_ADDRESS_MISMATCH,
      message:
        'StableFX create trade address does not match the selected wallet address.',
    });
  }

  private assertMessageAddressFields(
    message: Record<string, unknown>,
    expectedAddress: string,
  ): void {
    const conflicts = this.collectMessageAddressFields(message).filter(
      (field) =>
        this.isSignerAddressField(field.path) &&
        field.address.toLowerCase() !== expectedAddress.toLowerCase(),
    );

    if (conflicts.length > 0) {
      this.logger.warn(
        `[user-swap-stablefx] Local address validation failed: ` +
          `provider=stablefx step=create_trade selectedAddress=${expectedAddress} ` +
          `createTradeAddress=${expectedAddress} messageAddressFields=${JSON.stringify(
            this.collectMessageAddressFields(message).map((field) => ({
              path: field.path,
              address: field.address,
              signerField: this.isSignerAddressField(field.path),
            })),
          )}`,
      );

      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.STABLEFX_ADDRESS_MISMATCH,
        message:
          'StableFX typed-data address fields do not match the create trade address.',
        details: {
          path: conflicts[0].path,
        },
      });
    }
  }

  private collectMessageAddressFields(
    value: unknown,
    path = 'message',
  ): Array<{ address: string; path: string }> {
    if (typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)) {
      return [{ address: value, path }];
    }

    if (Array.isArray(value)) {
      return value.flatMap((item, index) =>
        this.collectMessageAddressFields(item, `${path}.${index}`),
      );
    }

    if (!this.isRecord(value)) {
      return [];
    }

    return Object.entries(value).flatMap(([key, nested]) =>
      this.collectMessageAddressFields(nested, `${path}.${key}`),
    );
  }

  private isSignerAddressField(path: string): boolean {
    const finalKey = path.split('.').at(-1)?.toLowerCase() ?? '';
    const signerKeys = new Set([
      'account',
      'address',
      'from',
      'owner',
      'recipient',
      'recipientaddress',
      'signer',
      'taker',
      'trader',
      'user',
      'wallet',
    ]);
    const nonSignerKeys = new Set([
      'contract',
      'destination',
      'maker',
      'spender',
      'token',
      'to',
      'verifyingcontract',
    ]);

    if (nonSignerKeys.has(finalKey)) {
      return false;
    }

    return signerKeys.has(finalKey);
  }

  private baseUnitsToDecimalString(value: string, decimals: number): string {
    const trimmed = value?.trim();

    if (!trimmed || !/^\d+$/.test(trimmed)) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be a positive integer base-unit string.',
      });
    }

    const amount = BigInt(trimmed);

    if (amount <= 0n) {
      throw new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be greater than zero.',
      });
    }

    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const fraction = amount % scale;

    const fractionStr = fraction
      .toString()
      .padStart(decimals, '0')
      .replace(/0+$/, '');

    const stablefxFraction = fractionStr.padEnd(2, '0');

    return `${whole.toString()}.${stablefxFraction}`;
  }

  private extractObject(raw: unknown, source: string): Record<string, unknown> {
    if (this.isRecord(raw) && this.isRecord(raw.data)) {
      return raw.data;
    }

    if (this.isRecord(raw)) {
      return raw;
    }

    throw new BadGatewayException({
      code: USER_SWAP_ERROR_CODES.STABLEFX_UNEXPECTED_RESPONSE,
      message: `${source} returned a non-object response.`,
    });
  }

  private sanitizeUpstreamError(raw: unknown): Record<string, unknown> {
    if (!this.isRecord(raw)) {
      return {};
    }

    const source = this.isRecord(raw.error) ? raw.error : raw;
    const sanitized: Record<string, unknown> = {};

    if (typeof source.code === 'string' || typeof source.code === 'number') {
      sanitized.code = source.code;
    }

    if (typeof source.message === 'string') {
      sanitized.message = source.message;
    }

    return sanitized;
  }

  private coerceCode(code: unknown): number | undefined {
    if (typeof code === 'number') {
      return code;
    }

    if (typeof code === 'string' && /^\d+$/.test(code)) {
      return Number(code);
    }

    return undefined;
  }

  private parseJsonOrText(rawText: string): unknown {
    if (!rawText) {
      return {};
    }

    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }

  private getApiKey(): string {
    return process.env.CIRCLE_STABLEFX_API_KEY?.trim() ?? '';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
