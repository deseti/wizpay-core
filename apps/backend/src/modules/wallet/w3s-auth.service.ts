import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';

type W3sActionResult = Record<string, unknown>;
type W3sValidationIssue = {
  field: string;
  message: string;
};
export type StablefxSignDiagnostic = {
  amount: string;
  expectedSignerAddress: string;
  fromCurrency: string;
  quoteId: string;
  recipientAddress: string;
  toCurrency: string;
  typedData: Record<string, unknown>;
  walletId: string;
};

export type UserContractExecutionChallengeInput = {
  callData: string;
  contractAddress: string;
  idempotencyKey: string;
  refId: string;
  userToken: string;
  walletId: string;
};

const stablefxSignDiagnostics = new Map<string, StablefxSignDiagnostic>();
const CIRCLE_HTTP_TIMEOUT_MS = 20_000;

export function getStablefxSignDiagnostic(input: {
  expectedSignerAddress: string;
  quoteId: string;
}): StablefxSignDiagnostic | null {
  const key = getStablefxSignDiagnosticKey(
    input.quoteId,
    input.expectedSignerAddress,
  );

  return stablefxSignDiagnostics.get(key) ?? null;
}

function setStablefxSignDiagnostic(diagnostic: StablefxSignDiagnostic): void {
  stablefxSignDiagnostics.set(
    getStablefxSignDiagnosticKey(
      diagnostic.quoteId,
      diagnostic.expectedSignerAddress,
    ),
    diagnostic,
  );
}

function getStablefxSignDiagnosticKey(
  quoteId: string,
  expectedSignerAddress: string,
): string {
  return `${quoteId.trim()}::${expectedSignerAddress.trim().toLowerCase()}`;
}

/**
 * Server-side proxy for Circle W3S user-controlled wallet actions
 * that require the CIRCLE_API_KEY (which must never be exposed to the browser).
 *
 * The frontend calls these actions via the /w3s/action endpoint so the
 * sensitive API key stays on the server.
 */
@Injectable()
export class W3sAuthService {
  private readonly logger = new Logger(W3sAuthService.name);
  private readonly circleBaseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const envBaseUrl =
      this.configService.get<string>('CIRCLE_BASE_URL') ||
      this.configService.get<string>('NEXT_PUBLIC_CIRCLE_BASE_URL');

    if (envBaseUrl) {
      this.circleBaseUrl = envBaseUrl.replace(/\/+$/, '');
    } else {
      // Fall back based on CIRCLE_ENV
      const circleEnv = this.configService.get<string>('CIRCLE_ENV') ?? '';
      this.circleBaseUrl =
        circleEnv.toLowerCase() === 'sandbox'
          ? 'https://api-sandbox.circle.com'
          : 'https://api.circle.com';
    }

    this.logger.log(`Circle base URL: ${this.circleBaseUrl}`);
  }

  /**
   * Dispatch a W3S action by name. Returns the raw Circle API response payload.
   */
  async dispatch(
    action: string,
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    switch (action) {
      case 'createDeviceToken':
        return this.createDeviceToken(params);
      case 'requestEmailOtp':
        return this.requestEmailOtp(params);
      case 'refreshUserToken':
        return this.refreshUserToken(params);
      case 'createContractExecutionChallenge':
        return this.proxyUserAction(
          'POST',
          '/v1/w3s/user/transactions/contractExecution',
          params,
        );
      case 'createTransferChallenge':
        return this.createArcTransferChallenge(params);
      case 'estimateTransferFee':
        return this.estimateUserTransferFee(params);
      case 'createTypedDataChallenge':
        return this.proxyUserAction(
          'POST',
          '/v1/w3s/user/sign/typedData',
          params,
        );
      case 'bridge':
        return this.bridgeActionStatus(params);
      case 'getTransaction':
        return this.getTransaction(
          typeof params.transactionId === 'string' ? params.transactionId : '',
        );
      case 'getUserChallenge':
        return this.getUserChallenge(
          typeof params.challengeId === 'string' ? params.challengeId : '',
          typeof params.userToken === 'string' ? params.userToken : '',
        );
      case 'listUserChallenges':
        return this.listUserChallenges(
          typeof params.userToken === 'string' ? params.userToken : '',
        );
      case 'getUserTransaction':
        return this.getUserTransaction(
          typeof params.transactionId === 'string' ? params.transactionId : '',
          typeof params.userToken === 'string' ? params.userToken : '',
        );
      case 'listUserTransactions':
        return this.listUserTransactions(
          {
            walletId:
              typeof params.walletId === 'string' ? params.walletId : '',
            pageAfter:
              typeof params.pageAfter === 'string'
                ? params.pageAfter
                : undefined,
            from: typeof params.from === 'string' ? params.from : undefined,
          },
          typeof params.userToken === 'string' ? params.userToken : '',
        );
      case 'getWalletBalances':
        return this.getWalletBalances(params);
      case 'listTransactions':
        return this.listTransactions({
          blockchain:
            typeof params.blockchain === 'string'
              ? params.blockchain
              : undefined,
          destinationAddress:
            typeof params.destinationAddress === 'string'
              ? params.destinationAddress
              : undefined,
          walletIds:
            typeof params.walletIds === 'string' ? params.walletIds : undefined,
        });
      default:
        throw new Error(`Unknown W3S action: ${action}`);
    }
  }

  /** User-scoped contract execution used by direct App Wallet operations. */
  async createUserContractExecutionChallenge(
    input: UserContractExecutionChallengeInput,
  ): Promise<W3sActionResult> {
    return this.circleUserRequest({
      body: {
        callData: input.callData,
        contractAddress: input.contractAddress,
        feeLevel: 'MEDIUM',
        idempotencyKey: input.idempotencyKey,
        refId: input.refId,
        walletId: input.walletId,
      },
      method: 'POST',
      path: '/v1/w3s/user/transactions/contractExecution',
      userToken: input.userToken,
    });
  }

  async estimateUserContractExecutionFee(input: {
    callData: string;
    contractAddress: string;
    userToken: string;
    walletId: string;
  }): Promise<W3sActionResult> {
    return this.circleUserRequest({
      body: {
        callData: input.callData,
        contractAddress: input.contractAddress,
        walletId: input.walletId,
      },
      method: 'POST',
      path: '/v1/w3s/transactions/contractExecution/estimateFee',
      userToken: input.userToken,
    });
  }

  private async estimateUserTransferFee(
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    const userToken =
      typeof params.userToken === 'string' ? params.userToken.trim() : '';
    const normalized = this.normalizeUserActionParams(
      '/v1/w3s/transactions/transfer/estimateFee',
      params,
    );
    this.validateTransferFields(normalized);
    if (!userToken) {
      this.throwValidationError([
        { field: 'userToken', message: 'userToken is required' },
      ]);
    }
    return this.circleUserRequest({
      body: {
        amounts: normalized.amounts,
        destinationAddress: normalized.destinationAddress,
        tokenId: normalized.tokenId,
        walletId: normalized.walletId,
      },
      method: 'POST',
      path: '/v1/w3s/transactions/transfer/estimateFee',
      userToken,
    });
  }

  private async createArcTransferChallenge(
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    if (params.wizpayChain !== 'ARC-TESTNET') {
      this.throwValidationError([
        {
          field: 'wizpayChain',
          message: 'ARC-TESTNET execution context is required',
        },
      ]);
    }
    const userToken =
      typeof params.userToken === 'string' ? params.userToken.trim() : '';
    const normalized = this.normalizeUserActionParams(
      '/v1/w3s/user/transactions/transfer',
      params,
    );
    this.validateTransferFields(normalized);
    const requestId = randomUUID();
    const walletRef = this.stableIdentifier(String(normalized.walletId));
    const startedAt = Date.now();
    let stage = 'preflight_estimate';
    this.logger.log(
      `W3S lifecycle requestId=${requestId} action=createTransferChallenge stage=${stage} walletRef=${walletRef} outcome=started`,
    );
    try {
      const estimate = await this.estimateUserTransferFee({
        ...normalized,
        userToken,
      }).catch(() => ({}));
      const reserveUnits = this.arcGasReserveUnits(estimate);
      stage = 'preflight_balances';
      const balances = await this.getWalletBalances({
        userToken,
        walletId: normalized.walletId,
      });
      stage = 'preflight_validation';
      this.assertArcTransferBalance(
        normalized,
        balances.tokenBalances,
        reserveUnits,
      );
      stage = 'circle_transfer_creation';
      const result = await this.proxyUserAction(
        'POST',
        '/v1/w3s/user/transactions/transfer',
        {
          ...normalized,
          userToken,
        },
      );
      this.logger.log(
        `W3S lifecycle requestId=${requestId} action=createTransferChallenge stage=${stage} walletRef=${walletRef} outcome=success durationMs=${Date.now() - startedAt}`,
      );
      return result;
    } catch (cause) {
      const error = cause as Error & {
        code?: string | number;
        status?: number;
      };
      this.logger.warn(
        `W3S lifecycle requestId=${requestId} action=createTransferChallenge stage=${stage} walletRef=${walletRef} outcome=failed status=${error.status ?? 500} code=${error.code ?? 'UNCLASSIFIED'} durationMs=${Date.now() - startedAt}`,
      );
      throw cause;
    }
  }

  /** Read a transaction with the same authenticated user context that created it. */
  async getUserTransaction(
    transactionId: string,
    userToken: string,
  ): Promise<W3sActionResult> {
    const normalizedTransactionId = transactionId.trim();
    const normalizedUserToken = userToken.trim();
    if (!normalizedTransactionId) {
      throw new Error('Missing required field: transactionId');
    }
    if (!normalizedUserToken) {
      throw new Error('Missing required field: userToken');
    }

    return this.circleUserRequest({
      method: 'GET',
      path: `/v1/w3s/transactions/${encodeURIComponent(normalizedTransactionId)}`,
      userToken: normalizedUserToken,
    });
  }

  /** List only transactions visible to the authenticated Circle user. */
  async listUserTransactions(
    input: { walletId: string; pageAfter?: string; from?: string },
    userToken: string,
  ): Promise<W3sActionResult> {
    const walletId = input.walletId.trim();
    const normalizedUserToken = userToken.trim();
    if (!walletId) {
      throw new Error('Missing required field: walletId');
    }
    if (!normalizedUserToken) {
      throw new Error('Missing required field: userToken');
    }
    const query = new URLSearchParams({
      pageSize: '50',
      order: 'ASC',
      walletIds: walletId,
    });
    if (input.pageAfter?.trim()) query.set('pageAfter', input.pageAfter.trim());
    if (input.from?.trim()) query.set('from', input.from.trim());
    return this.circleUserRequest({
      method: 'GET',
      path: `/v1/w3s/transactions?${query.toString()}`,
      userToken: normalizedUserToken,
    });
  }

  /** Read-only, authenticated token metadata source for activity reconciliation. */
  async listUserTokenBalances(walletId: string, userToken: string): Promise<W3sActionResult> {
    if (!walletId.trim() || !userToken.trim()) throw new Error('Missing Circle wallet authentication.');
    return this.circleUserRequest({
      method: 'GET',
      path: `/v1/w3s/wallets/${encodeURIComponent(walletId.trim())}/balances`,
      userToken: userToken.trim(),
    });
  }

  private async refreshUserToken(
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    const userToken =
      typeof params.userToken === 'string' ? params.userToken.trim() : '';
    const refreshToken =
      typeof params.refreshToken === 'string' ? params.refreshToken.trim() : '';
    const deviceId =
      typeof params.deviceId === 'string' ? params.deviceId.trim() : '';
    if (!userToken || !refreshToken || !deviceId) {
      this.throwValidationError([
        ...(!userToken
          ? [{ field: 'userToken', message: 'userToken is required' }]
          : []),
        ...(!refreshToken
          ? [{ field: 'refreshToken', message: 'refreshToken is required' }]
          : []),
        ...(!deviceId
          ? [{ field: 'deviceId', message: 'deviceId is required' }]
          : []),
      ]);
    }
    return this.circleUserRequest({
      body: { deviceId, idempotencyKey: randomUUID(), refreshToken },
      method: 'POST',
      path: '/v1/w3s/users/token/refresh',
      userToken,
    });
  }

  async getUserChallenge(
    challengeId: string,
    userToken: string,
  ): Promise<W3sActionResult> {
    const normalizedChallengeId = challengeId.trim();
    const normalizedUserToken = userToken.trim();
    if (!normalizedChallengeId) {
      throw new Error('Missing required field: challengeId');
    }
    if (!normalizedUserToken) {
      throw new Error('Missing required field: userToken');
    }
    return this.circleUserRequest({
      method: 'GET',
      path: `/v1/w3s/user/challenges/${encodeURIComponent(normalizedChallengeId)}`,
      userToken: normalizedUserToken,
    });
  }

  async listUserChallenges(userToken: string): Promise<W3sActionResult> {
    const normalizedUserToken = userToken.trim();
    if (!normalizedUserToken)
      throw new Error('Missing required field: userToken');
    return this.circleUserRequest({
      method: 'GET',
      path: '/v1/w3s/user/challenges',
      userToken: normalizedUserToken,
    });
  }
  /**
   * Creates a social login device token via Circle's server-side API.
   *
   * Correct endpoint for social login (Google/Email OTP):
   *   POST /v1/w3s/users/social/token
   *   Body: { deviceId, idempotencyKey }
   *   Response: { data: { deviceToken, deviceEncryptionKey } }
   *
   * NOTE: /v1/w3s/users/token is for PIN-based wallets and requires userId.
   *       Social login uses /v1/w3s/users/social/token which only needs deviceId.
   */
  private async createDeviceToken(
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    const apiKey = this.getCircleApiKey();
    const deviceId =
      typeof params.deviceId === 'string' ? params.deviceId.trim() : '';

    if (!deviceId) {
      throw new Error(
        'Missing required field: deviceId. ' +
          'Frontend must call sdk.getDeviceId() before requesting a device token.',
      );
    }

    const url = `${this.circleBaseUrl}/v1/w3s/users/social/token`;

    const requestId = randomUUID();
    const startedAt = Date.now();
    this.logger.log(
      `Circle lifecycle requestId=${requestId} stage=create_device_token outcome=started`,
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deviceId,
          idempotencyKey: randomUUID(),
        }),
        signal: AbortSignal.timeout(CIRCLE_HTTP_TIMEOUT_MS),
      });
    } catch (fetchErr) {
      this.logger.error(
        `Circle lifecycle requestId=${requestId} stage=create_device_token outcome=transport_error durationMs=${Date.now() - startedAt}`,
      );
      throw new Error(
        `Network error calling Circle API: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
      );
    }

    const raw = await res.text();
    this.logger.log(
      `Circle lifecycle requestId=${requestId} stage=create_device_token outcome=response status=${res.status} durationMs=${Date.now() - startedAt}`,
    );

    if (!res.ok) {
      this.logger.error(`Circle API error [${res.status}]`);
      throw new Error(`Circle API error (${res.status})`);
    }

    let json: { data?: { deviceToken?: string; deviceEncryptionKey?: string } };
    try {
      const parsed = JSON.parse(raw) as unknown;
      json = this.isRecord(parsed) ? parsed : {};
    } catch {
      this.logger.error('Circle response is not valid JSON.');
      throw new Error('Circle returned invalid JSON');
    }

    const data = json.data;

    if (!data?.deviceToken || !data?.deviceEncryptionKey) {
      this.logger.error('Invalid Circle response shape:', {
        hasData: !!data,
        keys: data ? Object.keys(data) : [],
      });
      throw new Error(
        `Invalid Circle response. ` +
          `Expected data.deviceToken and data.deviceEncryptionKey. ` +
          `Got keys: [${data ? Object.keys(data).join(', ') : 'no data'}]`,
      );
    }

    this.logger.log(
      `Circle lifecycle requestId=${requestId} stage=create_device_token outcome=success durationMs=${Date.now() - startedAt}`,
    );

    return {
      deviceToken: data.deviceToken,
      deviceEncryptionKey: data.deviceEncryptionKey,
    };
  }

  /**
   * Requests an email OTP for the given user via Circle's server-side API.
   */
  private async requestEmailOtp(
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    const deviceId =
      typeof params.deviceId === 'string' ? params.deviceId.trim() : '';
    const email = typeof params.email === 'string' ? params.email.trim() : '';

    if (!email) {
      throw new Error('Missing required field: email');
    }

    const otpResponse = await this.circleServerRequest<{
      deviceToken?: string;
      deviceEncryptionKey?: string;
      otpToken?: string;
    }>({
      body: {
        deviceId,
        email,
        idempotencyKey: randomUUID(),
      },
      method: 'POST',
      path: '/v1/w3s/users/email/token',
    });

    return {
      deviceEncryptionKey: otpResponse.deviceEncryptionKey ?? '',
      deviceToken: otpResponse.deviceToken ?? '',
      otpToken: otpResponse.otpToken ?? '',
    };
  }

  /**
   * Get wallet balances for a given walletId.
   */
  private async getWalletBalances(
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    const walletId =
      typeof params.walletId === 'string' ? params.walletId.trim() : '';
    const userToken =
      typeof params.userToken === 'string' ? params.userToken.trim() : '';

    if (!walletId) {
      throw new Error('Missing required field: walletId');
    }

    const response = await this.circleUserRequest<{
      tokenBalances?: unknown[];
    }>({
      method: 'GET',
      path: `/v1/w3s/wallets/${walletId}/balances`,
      userToken,
    });

    return {
      tokenBalances: response.tokenBalances ?? [],
    };
  }

  private bridgeActionStatus(params: Record<string, unknown>): W3sActionResult {
    const normalized = this.normalizeBridgeActionParams(params);

    return {
      error: 'NOT_IMPLEMENTED',
      feature: 'bridge',
      message:
        'Direct /w3s/action bridge execution is not used. Create a bridge task with POST /tasks after the W3S transfer challenge deposits USDC into the source treasury wallet.',
      supportedEndpoint: '/tasks',
      expectedTaskPayload: normalized,
    };
  }

  /**
   * Read a Circle W3S transaction by id. This is read-only and returns the
   * raw transaction payload so callers can decide whether a txHash is usable.
   */
  async getTransaction(transactionId: string): Promise<W3sActionResult> {
    const normalizedTransactionId = transactionId.trim();

    if (!normalizedTransactionId) {
      throw new Error('Missing required field: transactionId');
    }

    return this.circleServerRequest<W3sActionResult>({
      method: 'GET',
      path: `/v1/w3s/transactions/${encodeURIComponent(normalizedTransactionId)}`,
    });
  }

  /**
   * List Circle W3S transactions with documented read-only filters. Callers
   * must still match the returned transaction fields before trusting a txHash.
   */
  async listTransactions(params: {
    blockchain?: string;
    destinationAddress?: string;
    walletIds?: string;
  }): Promise<W3sActionResult> {
    const query = new URLSearchParams();

    if (params.blockchain?.trim()) {
      query.set('blockchain', params.blockchain.trim());
    }

    if (params.destinationAddress?.trim()) {
      query.set('destinationAddress', params.destinationAddress.trim());
    }

    if (params.walletIds?.trim()) {
      query.set('walletIds', params.walletIds.trim());
    }

    return this.circleServerRequest<W3sActionResult>({
      method: 'GET',
      path: `/v1/w3s/transactions${query.size ? `?${query.toString()}` : ''}`,
    });
  }

  /**
   * Proxy a user-scoped action (requires userToken in params).
   */
  private async proxyUserAction(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown>,
  ): Promise<W3sActionResult> {
    const userToken =
      typeof params.userToken === 'string' ? params.userToken.trim() : '';

    if (!userToken) {
      this.throwValidationError([
        { field: 'userToken', message: 'userToken is required' },
      ]);
    }

    const bodyParams = this.normalizeUserActionParams(path, params);
    this.validateUserActionParams(path, bodyParams);
    const stablefxDiagnosticsEnabled =
      process.env.WIZPAY_STABLEFX_SIGN_DIAGNOSTICS === 'true';
    const stablefxDiagnostics = stablefxDiagnosticsEnabled
      ? this.readStablefxDiagnostics(path, bodyParams)
      : null;
    const currentAppWalletAddress =
      stablefxDiagnosticsEnabled && stablefxDiagnostics
        ? await this.resolveCurrentAppWalletAddress(
            stablefxDiagnostics.walletId,
          )
        : null;
    const circleBodyParams = { ...bodyParams };
    delete circleBodyParams.stablefxDiagnostics;

    if (stablefxDiagnosticsEnabled && stablefxDiagnostics) {
      const typedData = this.readTypedData(bodyParams);

      if (typedData) {
        setStablefxSignDiagnostic({
          ...stablefxDiagnostics,
          typedData,
        });
      }

      this.logger.log(
        `[stablefx-app-wallet-sign] provider=stablefx step=sign_typed_data ` +
          `walletId=${stablefxDiagnostics.walletId} ` +
          `currentAppWalletAddress=${currentAppWalletAddress ?? 'unavailable'} ` +
          `expectedSignerAddress=${stablefxDiagnostics.expectedSignerAddress} ` +
          `recipientAddress=${stablefxDiagnostics.recipientAddress} ` +
          `quoteId=${stablefxDiagnostics.quoteId} ` +
          `fromCurrency=${stablefxDiagnostics.fromCurrency} ` +
          `toCurrency=${stablefxDiagnostics.toCurrency} ` +
          `amount=${stablefxDiagnostics.amount} ` +
          `typedDataCached=${typedData ? 'true' : 'false'}`,
      );
    }

    if (method === 'POST') {
      return this.circleUserRequest({
        body: {
          ...circleBodyParams,
          idempotencyKey:
            typeof circleBodyParams.idempotencyKey === 'string'
              ? circleBodyParams.idempotencyKey
              : randomUUID(),
        },
        method,
        path,
        userToken,
      });
    }

    return this.circleUserRequest({ method, path, userToken });
  }

  private readStablefxDiagnostics(
    path: string,
    body: Record<string, unknown>,
  ): {
    amount: string;
    expectedSignerAddress: string;
    fromCurrency: string;
    quoteId: string;
    recipientAddress: string;
    toCurrency: string;
    walletId: string;
  } | null {
    if (path !== '/v1/w3s/user/sign/typedData') {
      return null;
    }

    const diagnostics = body.stablefxDiagnostics;

    if (!this.isRecord(diagnostics)) {
      return null;
    }

    const walletId = this.readTrimmedString(body, 'walletId');
    const expectedSignerAddress = this.readTrimmedString(
      diagnostics,
      'expectedSignerAddress',
    );
    const recipientAddress = this.readTrimmedString(
      diagnostics,
      'recipientAddress',
    );
    const quoteId = this.readTrimmedString(diagnostics, 'quoteId');
    const fromCurrency = this.readTrimmedString(diagnostics, 'fromCurrency');
    const toCurrency = this.readTrimmedString(diagnostics, 'toCurrency');
    const amount = this.readTrimmedString(diagnostics, 'amount');

    if (
      !walletId ||
      !expectedSignerAddress ||
      !recipientAddress ||
      !quoteId ||
      !fromCurrency ||
      !toCurrency ||
      !amount
    ) {
      return null;
    }

    return {
      amount,
      expectedSignerAddress,
      fromCurrency,
      quoteId,
      recipientAddress,
      toCurrency,
      walletId,
    };
  }

  private async resolveCurrentAppWalletAddress(
    walletId: string,
  ): Promise<string | null> {
    try {
      const wallet = await this.prisma.userWallet.findUnique({
        where: { walletId },
        select: { address: true },
      });

      return typeof wallet?.address === 'string' && wallet.address.trim()
        ? wallet.address.trim()
        : null;
    } catch (error) {
      this.logger.warn(
        `[stablefx-app-wallet-sign] Wallet lookup failed before typed-data signing: ` +
          `walletId=${walletId} error=${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  private readTypedData(
    body: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (this.isRecord(body.typedData)) {
      return body.typedData;
    }

    if (typeof body.data !== 'string' || !body.data.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(body.data) as unknown;

      return this.isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Make a server-authenticated request to Circle (uses CIRCLE_API_KEY only).
   */
  private async circleServerRequest<T extends Record<string, unknown>>(input: {
    body?: Record<string, unknown>;
    method: 'GET' | 'POST';
    path: string;
  }): Promise<T> {
    const url = new URL(input.path, this.circleBaseUrl).toString();
    const safePath = this.safeCircleRoute(input.path);
    const apiKey = this.getCircleApiKey();

    const requestId = randomUUID();
    const startedAt = Date.now();
    this.logger.log(
      `Circle lifecycle requestId=${requestId} stage=server_request method=${input.method} path=${safePath} outcome=started`,
    );

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Request-Id': requestId,
      'Content-Type': 'application/json',
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal: AbortSignal.timeout(CIRCLE_HTTP_TIMEOUT_MS),
      });
    } catch (fetchError) {
      this.logger.error(
        `Circle lifecycle requestId=${requestId} stage=server_request path=${safePath} outcome=transport_error durationMs=${Date.now() - startedAt}`,
      );
      throw fetchError;
    }

    const rawText = await response.text();
    this.logger.log(
      `Circle response status: ${response.status} | body length: ${rawText.length}`,
    );

    let payload: {
      code?: string | number;
      data?: T;
      error?: string;
      message?: string;
    };

    try {
      const parsed = JSON.parse(rawText) as unknown;
      payload = this.isRecord(parsed) ? parsed : {};
    } catch {
      this.logger.error(
        `Circle lifecycle requestId=${requestId} stage=server_request path=${safePath} outcome=invalid_json`,
      );
      payload = {};
    }

    if (!response.ok) {
      const message =
        payload.error ||
        payload.message ||
        `Circle server request failed with status ${response.status}.`;
      this.logger.error(
        `Circle lifecycle requestId=${requestId} stage=server_request path=${safePath} outcome=upstream_error status=${response.status}`,
        {
          path: safePath,
          code: payload.code,
          bodyLength: rawText.length,
        },
      );
      const error = new Error(message) as Error & {
        code?: string | number;
        status?: number;
      };
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }

    return payload.data ?? (payload as T);
  }

  /**
   * Make a user-authenticated request to Circle (uses both API key and user token).
   */
  private async circleUserRequest<T extends Record<string, unknown>>(input: {
    body?: Record<string, unknown>;
    method: 'GET' | 'POST';
    path: string;
    userToken: string;
  }): Promise<T> {
    const url = new URL(input.path, this.circleBaseUrl).toString();
    const safePath = this.safeCircleRoute(input.path);
    const apiKey = this.getCircleApiKey();
    const requestId = randomUUID();
    const startedAt = Date.now();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Request-Id': requestId,
    };

    if (input.body) {
      headers['Content-Type'] = 'application/json';
    }

    if (input.userToken) {
      headers['X-User-Token'] = input.userToken;
    }

    this.logger.log(
      `Circle lifecycle requestId=${requestId} stage=user_request method=${input.method} path=${safePath} outcome=started`,
    );

    const response = await fetch(url, {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: AbortSignal.timeout(CIRCLE_HTTP_TIMEOUT_MS),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      code?: string | number;
      data?: T;
      error?: string;
      message?: string;
    };

    if (!response.ok) {
      const message =
        payload.error ||
        payload.message ||
        `Circle user request failed with status ${response.status}.`;
      this.logger.error(
        `Circle lifecycle requestId=${requestId} stage=user_request method=${input.method} path=${safePath} outcome=upstream_error status=${response.status} durationMs=${Date.now() - startedAt}`,
        {
          bodyLength: JSON.stringify(payload).length,
          code: payload.code,
          path: safePath,
        },
      );
      const error = new Error(message) as Error & {
        code?: string | number;
        details?: unknown;
        retryAfterMs?: number | null;
        status?: number;
      };
      error.code = payload.code;
      error.details = {
        bodyKeys: input.body ? Object.keys(input.body) : [],
        circleMessage: payload.message,
        circleError: payload.error,
        circleStatus: response.status,
        method: input.method,
        path: input.path,
      };
      error.status = response.status;
      if (response.status === 429) {
        const retryHeader = response.headers.get('Retry-After');
        error.retryAfterMs = retryHeader
          ? parseInt(retryHeader, 10) * 1000
          : null;
      }
      throw error;
    }

    this.logger.log(
      `Circle lifecycle requestId=${requestId} stage=user_request path=${safePath} outcome=success durationMs=${Date.now() - startedAt}`,
    );

    return payload.data ?? (payload as T);
  }

  private getCircleApiKey(): string {
    const apiKey = this.configService.get<string>('CIRCLE_API_KEY');

    if (!apiKey) {
      throw new Error(
        'CIRCLE_API_KEY is not configured on the backend. ' +
          'Set it in your .env file and restart the server.',
      );
    }

    return apiKey;
  }

  private normalizeUserActionParams(
    path: string,
    params: Record<string, unknown>,
  ) {
    const { payload, ...rest } = params;
    delete rest.userToken;
    const payloadParams =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const normalized = {
      ...payloadParams,
      ...rest,
    };
    delete normalized.wizpayChain;

    if (typeof normalized.walletId === 'string') {
      normalized.walletId = normalized.walletId.trim();
    }

    if (typeof normalized.contractAddress === 'string') {
      normalized.contractAddress = normalized.contractAddress
        .trim()
        .toLowerCase();
    }

    if (typeof normalized.destinationAddress === 'string') {
      const destAddr = normalized.destinationAddress.trim();
      normalized.destinationAddress = destAddr.startsWith('0x')
        ? destAddr.toLowerCase()
        : destAddr;
    }

    if (Array.isArray(normalized.amounts)) {
      normalized.amounts = normalized.amounts.map((amount) => String(amount));
    }

    if (typeof normalized.amount === 'number') {
      normalized.amount = String(normalized.amount);
    }

    if (typeof normalized.blockchain === 'string') {
      normalized.blockchain = normalized.blockchain
        .trim()
        .toUpperCase()
        .replace(/_/g, '-');
    }

    if (typeof normalized.sourceChain === 'string') {
      normalized.sourceChain = normalized.sourceChain
        .trim()
        .toUpperCase()
        .replace(/_/g, '-');
    }

    if (typeof normalized.destinationChain === 'string') {
      normalized.destinationChain = normalized.destinationChain
        .trim()
        .toUpperCase()
        .replace(/_/g, '-');
    }

    if (
      path === '/v1/w3s/user/sign/typedData' &&
      typeof normalized.data !== 'string'
    ) {
      const typedData =
        normalized.typedData && typeof normalized.typedData === 'object'
          ? normalized.typedData
          : normalized.payload;

      if (typedData && typeof typedData === 'object') {
        normalized.data = JSON.stringify(typedData);
      }
    }

    return normalized;
  }

  private validateUserActionParams(
    path: string,
    body: Record<string, unknown>,
  ) {
    const issues: W3sValidationIssue[] = [];

    if (!this.isNonEmptyString(body.walletId)) {
      issues.push({ field: 'walletId', message: 'walletId is required' });
    }

    if (path === '/v1/w3s/user/transactions/contractExecution') {
      if (!this.isNonEmptyString(body.contractAddress)) {
        issues.push({
          field: 'contractAddress',
          message: 'contractAddress is required',
        });
      }

      if (
        !this.isNonEmptyString(body.callData) &&
        !this.isNonEmptyString(body.abiFunctionSignature)
      ) {
        issues.push({
          field: 'callData',
          message: 'callData or abiFunctionSignature is required',
        });
      }
    }

    if (path === '/v1/w3s/user/transactions/transfer') {
      if (!this.isNonEmptyString(body.destinationAddress)) {
        issues.push({
          field: 'destinationAddress',
          message: 'destinationAddress is required',
        });
      }

      if (
        !Array.isArray(body.amounts) ||
        body.amounts.length === 0 ||
        !body.amounts.every((amount) => this.isNonEmptyString(amount))
      ) {
        issues.push({
          field: 'amounts',
          message: 'amounts must be a non-empty string array',
        });
      }

      if (!this.isNonEmptyString(body.tokenId)) {
        issues.push({ field: 'tokenId', message: 'tokenId is required' });
      }
    }

    if (path === '/v1/w3s/user/sign/typedData') {
      if (!this.isNonEmptyString(body.data)) {
        issues.push({ field: 'data', message: 'data is required' });
      }
    }

    if (issues.length > 0) {
      this.throwValidationError(issues);
    }
  }

  private validateTransferFields(body: Record<string, unknown>) {
    const issues: W3sValidationIssue[] = [];
    if (!this.isNonEmptyString(body.walletId))
      issues.push({ field: 'walletId', message: 'walletId is required' });
    if (!this.isNonEmptyString(body.destinationAddress))
      issues.push({
        field: 'destinationAddress',
        message: 'destinationAddress is required',
      });
    if (
      !Array.isArray(body.amounts) ||
      body.amounts.length !== 1 ||
      !body.amounts.every((amount) => this.isNonEmptyString(amount))
    )
      issues.push({
        field: 'amounts',
        message: 'exactly one transfer amount is required',
      });
    if (!this.isNonEmptyString(body.tokenId))
      issues.push({ field: 'tokenId', message: 'tokenId is required' });
    if (issues.length) this.throwValidationError(issues);
  }

  private decimalUnits(value: unknown, decimals: number): bigint | null {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
      return null;
    const [whole, fraction = ''] = value.split('.');
    if (fraction.length > decimals) return null;
    return (
      BigInt(whole) * 10n ** BigInt(decimals) +
      BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))
    );
  }

  private decimalUnitsFloor(value: unknown, decimals: number): bigint | null {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
      return null;
    const [whole, fraction = ''] = value.split('.');
    return (
      BigInt(whole) * 10n ** BigInt(decimals) +
      BigInt(
        (fraction.slice(0, decimals) + '0'.repeat(decimals)).slice(0, decimals),
      )
    );
  }

  private arcGasReserveUnits(estimate: W3sActionResult): bigint {
    const level = [estimate.medium, estimate.high, estimate.low].find((value) =>
      this.isRecord(value),
    );
    const gasLimit =
      typeof level?.gasLimit === 'string' && /^\d+$/.test(level.gasLimit)
        ? BigInt(level.gasLimit)
        : null;
    const maxFeeGwei = this.decimalUnits(level?.maxFee ?? level?.gasPrice, 9);
    if (!gasLimit || maxFeeGwei === null) return 100_000n;
    const feeWei = gasLimit * maxFeeGwei;
    const feeUnits = (feeWei + 10n ** 12n - 1n) / 10n ** 12n;
    const variableMargin = (feeUnits * 2_000n + 9_999n) / 10_000n;
    return feeUnits + variableMargin + 5_000n;
  }

  private assertArcTransferBalance(
    request: Record<string, unknown>,
    balances: unknown,
    reserveUnits: bigint,
  ) {
    if (!Array.isArray(balances))
      this.throwTransferPreflightError(
        'W3S_BALANCES_UNAVAILABLE',
        'Circle wallet balances are unavailable for gas validation.',
      );
    const rows = balances.filter((value): value is Record<string, unknown> =>
      this.isRecord(value),
    );
    const tokenId = String(request.tokenId);
    const input = rows.find(
      (row) => this.isRecord(row.token) && row.token.id === tokenId,
    );
    if (!input)
      this.throwTransferPreflightError(
        'W3S_TRANSFER_TOKEN_NOT_FOUND',
        'The selected transfer token is not available in this Arc wallet.',
      );
    const inputToken = this.isRecord(input.token) ? input.token : {};
    const inputIsNativeUsdc =
      inputToken.isNative === true &&
      String(inputToken.symbol).toUpperCase() === 'USDC';
    const nativeUsdcRows = rows.filter(
      (row) =>
        this.isRecord(row.token) &&
        row.token.isNative === true &&
        String(row.token.symbol).toUpperCase() === 'USDC',
    );
    const usdc = inputIsNativeUsdc
      ? input
      : nativeUsdcRows.length === 1
        ? nativeUsdcRows[0]
        : undefined;
    if (!usdc)
      this.throwTransferPreflightError(
        'W3S_NATIVE_FEE_TOKEN_NOT_FOUND',
        'The Arc native USDC fee balance could not be identified safely.',
      );
    const inputUnits = this.decimalUnitsFloor(input.amount, 6);
    const usdcUnits = this.decimalUnitsFloor(usdc.amount, 6);
    const amount = this.decimalUnits((request.amounts as unknown[])[0], 6);
    if (inputUnits === null || usdcUnits === null || amount === null)
      this.throwTransferPreflightError(
        'W3S_BALANCE_FORMAT_INVALID',
        'Circle wallet balances could not be validated for network fees.',
      );
    if (amount > inputUnits)
      this.throwTransferPreflightError(
        'W3S_INSUFFICIENT_TRANSFER_BALANCE',
        'Insufficient transfer token balance.',
      );
    const inputIsUsdc =
      inputToken.id === (usdc.token as Record<string, unknown>).id;
    if (
      (inputIsUsdc && amount + reserveUnits > usdcUnits) ||
      (!inputIsUsdc && reserveUnits > usdcUnits)
    ) {
      this.throwTransferPreflightError(
        'W3S_INSUFFICIENT_ARC_GAS',
        'Leave enough USDC available for network fees.',
      );
    }
  }

  private throwTransferPreflightError(code: string, message: string): never {
    const error = new Error(message) as Error & {
      code: string;
      details: Record<string, unknown>;
      status: number;
    };
    error.code = code;
    error.details = {
      challengeCreationAttempted: false,
      lifecycleStage: 'preflight_validation',
    };
    error.status = 422;
    throw error;
  }

  private stableIdentifier(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }

  private safeCircleRoute(path: string): string {
    const parsed = new URL(path, 'https://circle.invalid');
    const route = parsed.pathname.replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
      '/:id',
    );
    const queryKeys = [...new Set(parsed.searchParams.keys())].sort();
    return queryKeys.length ? `${route}?fields=${queryKeys.join(',')}` : route;
  }

  private throwValidationError(issues: W3sValidationIssue[]): never {
    const error = new Error('W3S validation failed') as Error & {
      code?: string;
      details?: { errors: W3sValidationIssue[] };
      status?: number;
    };
    error.code = 'W3S_VALIDATION_FAILED';
    error.details = { errors: issues };
    error.status = 400;
    throw error;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private readTrimmedString(
    source: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }

  private normalizeBridgeActionParams(params: Record<string, unknown>) {
    const normalized = this.normalizeUserActionParams('bridge', params);
    const sourceChain =
      this.readBridgeChain(normalized, 'sourceChain') ??
      this.readBridgeChain(normalized, 'sourceBlockchain');
    const destinationChain =
      this.readBridgeChain(normalized, 'destinationChain') ??
      this.readBridgeChain(normalized, 'destinationBlockchain') ??
      this.readBridgeChain(normalized, 'blockchain');

    return {
      amount:
        typeof normalized.amount === 'string'
          ? normalized.amount
          : typeof normalized.amount === 'number' ||
              typeof normalized.amount === 'bigint'
            ? String(normalized.amount)
            : '',
      destinationAddress:
        typeof normalized.destinationAddress === 'string'
          ? normalized.destinationAddress
          : '',
      destinationChain,
      sourceChain,
      token:
        typeof normalized.token === 'string'
          ? normalized.token.trim().toUpperCase()
          : 'USDC',
      walletId:
        typeof normalized.walletId === 'string' ? normalized.walletId : '',
    };
  }

  private readBridgeChain(source: Record<string, unknown>, key: string) {
    const value = source[key];

    return typeof value === 'string' && value.trim()
      ? value.trim().toUpperCase().replace(/_/g, '-')
      : null;
  }
}
