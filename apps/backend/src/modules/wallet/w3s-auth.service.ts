import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

type W3sActionResult = Record<string, unknown>;
type W3sValidationIssue = {
  field: string;
  message: string;
};

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

  constructor(private readonly configService: ConfigService) {
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
      case 'createContractExecutionChallenge':
        return this.proxyUserAction(
          'POST',
          '/v1/w3s/user/transactions/contractExecution',
          params,
        );
      case 'createTransferChallenge':
        return this.proxyUserAction(
          'POST',
          '/v1/w3s/user/transactions/transfer',
          params,
        );
      case 'createTypedDataChallenge':
        return this.proxyUserAction(
          'POST',
          '/v1/w3s/user/sign/typedData',
          params,
        );
      case 'bridge':
        return this.bridgeActionStatus(params);
      case 'getWalletBalances':
        return this.getWalletBalances(params);
      default:
        throw new Error(`Unknown W3S action: ${action}`);
    }
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

    this.logger.log('createDeviceToken:', {
      url,
      deviceId: deviceId.slice(0, 20) + '...',
      keyPrefix: apiKey.slice(0, 12),
    });

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
      });
    } catch (fetchErr) {
      this.logger.error('Circle fetch FAILED:', fetchErr);
      throw new Error(
        `Network error calling Circle API: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
      );
    }

    const raw = await res.text();
    this.logger.log(
      `Circle response status: ${res.status} | body length: ${raw.length}`,
    );

    if (!res.ok) {
      this.logger.error(`Circle API error [${res.status}]`);
      throw new Error(`Circle API error (${res.status})`);
    }

    let json: { data?: { deviceToken?: string; deviceEncryptionKey?: string } };
    try {
      json = JSON.parse(raw);
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
      `createDeviceToken SUCCESS: deviceToken=${data.deviceToken.slice(0, 20)}..., ` +
        `deviceEncryptionKey=${data.deviceEncryptionKey.slice(0, 10)}...`,
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

  private bridgeActionStatus(
    params: Record<string, unknown>,
  ): W3sActionResult {
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

    if (method === 'POST') {
      return this.circleUserRequest({
        body: {
          ...bodyParams,
          idempotencyKey:
            typeof bodyParams.idempotencyKey === 'string'
              ? bodyParams.idempotencyKey
              : randomUUID(),
        },
        method,
        path,
        userToken,
      });
    }

    return this.circleUserRequest({ method, path, userToken });
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
    const apiKey = this.getCircleApiKey();

    this.logger.log(
      `Circle request: ${input.method} ${url} | API key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`,
    );

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body ? JSON.stringify(input.body) : undefined,
      });
    } catch (fetchError) {
      this.logger.error(
        `Circle fetch failed for ${url}:`,
        fetchError instanceof Error ? fetchError.message : fetchError,
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
      payload = JSON.parse(rawText);
    } catch {
      this.logger.error(
        `Circle response is not valid JSON: ${rawText.slice(0, 500)}`,
      );
      payload = {} as typeof payload;
    }

    if (!response.ok) {
      const message =
        payload.error ||
        payload.message ||
        `Circle server request failed with status ${response.status}.`;
      this.logger.error(`Circle API error [${response.status}]: ${message}`, {
        path: input.path,
        code: payload.code,
        bodyLength: rawText.length,
      });
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
    const apiKey = this.getCircleApiKey();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    if (input.body) {
      headers['Content-Type'] = 'application/json';
    }

    if (input.userToken) {
      headers['X-User-Token'] = input.userToken;
    }

    this.logger.log('Circle user request:', {
      bodyKeys: input.body ? Object.keys(input.body) : [],
      method: input.method,
      path: input.path,
    });

    const response = await fetch(url, {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
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
    const { payload, userToken: _removed, ...rest } = params;
    const payloadParams =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const normalized = {
      ...payloadParams,
      ...rest,
    };

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
      normalized.destinationAddress = destAddr.startsWith('0x') ? destAddr.toLowerCase() : destAddr;
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
          : String(normalized.amount ?? ''),
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
