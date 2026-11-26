import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import {
  PublisherAcceptedResponse,
  PublisherErrorEnvelope,
  PublisherHttpMethod,
  PublisherKeyAdmissionDecision,
  PublisherKeyAdmissionDeliveryReceipt,
  PublisherKeyBalance,
  PublisherKeyMeta,
  PublisherNamespace,
  PublisherProvider,
  PublisherProviderCompilePreview,
  PublisherRefundDrainSnapshot,
  PublisherRequestOptions,
} from './publisher.types';
import type { RuntimeIntent as PublisherRuntimeIntent } from '@raytone-lab/publisher-contracts';
import {
  retiredPublisherRequest,
} from './publisher-request-policy';

type NamespaceConfig = {
  tokenEnv: string;
  legacyTokenEnv?: string;
};

type PublisherConnection = {
  baseUrl: string;
  token: string;
};

const httpStatusAccepted = 202;

const NAMESPACE_CONFIG: Record<PublisherNamespace, NamespaceConfig> = {
  user: {
    tokenEnv: 'PUBLISHER_USER_TOKEN',
    legacyTokenEnv: 'PUBLISHER_PORTAL_TOKEN',
  },
  billing: {
    tokenEnv: 'PUBLISHER_BILLING_TOKEN',
  },
  admin: {
    tokenEnv: 'PUBLISHER_ADMIN_TOKEN',
    legacyTokenEnv: 'PUBLISHER_OPS_TOKEN',
  },
  sre: {
    tokenEnv: 'PUBLISHER_SRE_TOKEN',
  },
};

export class PublisherClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
    readonly retryable?: boolean,
  ) {
    super(message);
  }
}

@Injectable()
export class PublisherClient {
  private readonly logger = new Logger(PublisherClient.name);
  private lastRevisionMicros = 0;

  constructor(private readonly config: ConfigService) {}

  revision(): number {
    const now = Date.now() * 1000;
    this.lastRevisionMicros = Math.max(now, this.lastRevisionMicros + 1);
    return this.lastRevisionMicros;
  }

  idempotencyKey(
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: unknown,
  ): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({ namespace, method, path, body: body ?? null }))
      .digest('hex')
      .slice(0, 32);
    return `rd:${namespace}:${method.toLowerCase()}:${digest}`;
  }

  async request<TBody = unknown>(
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: TBody,
    options: PublisherRequestOptions = {},
  ): Promise<PublisherAcceptedResponse | null> {
    return this.requestWithExpectedStatus<PublisherAcceptedResponse, TBody>(
      namespace,
      method,
      path,
      httpStatusAccepted,
      body,
      options,
    );
  }

  async establishRefundDrain(
    drainId: string,
    keyHashes: string[],
  ): Promise<PublisherRefundDrainSnapshot | null> {
    const timeoutMs = Number(
      this.config.get<string>('PUBLISHER_REFUND_DRAIN_TIMEOUT_MS') ?? 10000,
    );
    return this.requestWithExpectedStatus<
      PublisherRefundDrainSnapshot,
      { key_hashes: string[] }
    >(
      'billing',
      'PUT',
      `/billing/api/v1/refund-drains/${encodeURIComponent(drainId)}`,
      200,
      { key_hashes: keyHashes },
      { timeoutMs },
    );
  }

  private async requestWithExpectedStatus<TResponse, TBody = unknown>(
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    expectedStatus: number,
    body?: TBody,
    options: PublisherRequestOptions = {},
  ): Promise<TResponse | null> {
    const retirement = retiredPublisherRequest({ method, path, body });
    if (retirement) {
      throw new PublisherClientError(
        retirement.message,
        400,
        retirement.code,
      );
    }
    const connection = this.connection(namespace);
    if (!connection) return null;
    const { baseUrl, token } = connection;

    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-ID': options.requestId ?? randomUUID(),
    };

    if (method !== 'GET') {
      headers['Idempotency-Key'] =
        options.idempotencyKey ?? this.idempotencyKey(namespace, method, path, body);
    }

    const timeoutMs = options.timeoutMs
      ?? Number(this.config.get<string>('PUBLISHER_TIMEOUT_MS') ?? 5000);
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const responseText = await response.text();
    const payload = responseText ? this.parseJson(responseText) : null;
    if (!response.ok) {
      const error = (payload as PublisherErrorEnvelope | null)?.error;
      throw new PublisherClientError(
        error?.message ?? `Publisher request failed: ${response.status}`,
        response.status,
        error?.code,
        error?.details,
      );
    }

    if (response.status !== expectedStatus) {
      throw new PublisherClientError(
        `Publisher returned unexpected status: ${response.status}`,
        response.status,
      );
    }

    return payload as TResponse;
  }

  async safeRequest<TBody = unknown>(
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: TBody,
    options: PublisherRequestOptions = {},
  ): Promise<PublisherAcceptedResponse | null> {
    try {
      return await this.request(namespace, method, path, body, options);
    } catch (err) {
      const retirement = retiredPublisherRequest({ method, path, body });
      if (err instanceof PublisherClientError && err.code === retirement?.code) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`publisher ${method} ${path} failed: ${message}`);
      return null;
    }
  }

  putUserKey(body: PublisherKeyMeta, options?: PublisherRequestOptions) {
    return this.safeRequest('user', 'PUT', '/user/api/v1/keys', body, options);
  }

  deleteUserKey(keyHash: string, options?: PublisherRequestOptions) {
    return this.safeRequest('user', 'DELETE', `/user/api/v1/keys/${keyHash}`, undefined, options);
  }

  revokeUserKey(keyHash: string, options?: PublisherRequestOptions) {
    return this.safeRequest('user', 'POST', '/user/api/v1/revoked-keys', { key_hash: keyHash }, options);
  }

  restoreUserKey(keyHash: string, options?: PublisherRequestOptions) {
    return this.safeRequest('user', 'DELETE', `/user/api/v1/revoked-keys/${keyHash}`, undefined, options);
  }

  putKeyBalance(keyId: string, body: PublisherKeyBalance, options?: PublisherRequestOptions) {
    return this.safeRequest('billing', 'PUT', `/billing/api/v1/key-balance/${keyId}`, body, options);
  }

  deleteKeyBalance(
    keyId: string,
    body: PublisherKeyAdmissionDecision,
    options?: PublisherRequestOptions,
  ) {
    return this.safeRequest('billing', 'DELETE', `/billing/api/v1/key-balance/${keyId}`, body, options);
  }

  async getKeyAdmissionDelivery(
    batchId: string,
    options: Pick<PublisherRequestOptions, 'requestId'> = {},
  ): Promise<PublisherKeyAdmissionDeliveryReceipt | null> {
    const connection = this.connection('billing');
    if (!connection) return null;
    const { baseUrl, token } = connection;
    const response = await fetch(
      `${baseUrl}/billing/api/v1/key-admission-deliveries/${encodeURIComponent(batchId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Request-ID': options.requestId ?? randomUUID(),
        },
        signal: AbortSignal.timeout(Number(this.config.get<string>('PUBLISHER_TIMEOUT_MS') ?? 5000)),
      },
    );
    const responseText = await response.text();
    const payload = responseText ? this.parseJson(responseText) : null;
    if (!response.ok) {
      const error = (payload as PublisherErrorEnvelope | null)?.error;
      throw new PublisherClientError(
        error?.message ?? `Publisher admission delivery request failed: ${response.status}`,
        response.status,
        error?.code,
        error?.details,
      );
    }
    if (response.status !== 200) {
      throw new PublisherClientError(
        `Publisher admission delivery returned unexpected status: ${response.status}`,
        response.status,
      );
    }
    return payload as PublisherKeyAdmissionDeliveryReceipt;
  }

  deleteProvider(providerId: string, options?: PublisherRequestOptions) {
    return this.safeRequest('admin', 'DELETE', `/admin/api/v1/providers/${providerId}`, undefined, options);
  }

  postRuntimeIntent(body: PublisherRuntimeIntent, options?: PublisherRequestOptions) {
    return this.safeRequest('admin', 'POST', '/admin/api/v1/providers:from-intent', body, options);
  }

  async compileProviderPreview(
    body: PublisherProvider,
    options: PublisherRequestOptions = {},
  ): Promise<PublisherProviderCompilePreview | null> {
    const connection = this.connection('admin');
    if (!connection) return null;
    const { baseUrl, token } = connection;

    const response = await fetch(`${baseUrl}/admin/api/v1/providers/compile-preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Request-ID': options.requestId ?? randomUUID(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(this.config.get<string>('PUBLISHER_TIMEOUT_MS') ?? 5000)),
    });
    const responseText = await response.text();
    const payload = responseText ? this.parseJson(responseText) : null;
    if (!response.ok) {
      const error = (payload as PublisherErrorEnvelope | null)?.error;
      throw new PublisherClientError(
        error?.message ?? `Publisher compile preview failed: ${response.status}`,
        response.status,
        error?.code,
        error?.details,
      );
    }
    return payload as PublisherProviderCompilePreview;
  }

  isExplicitlyDisabled(): boolean {
    return this.config.get<string>('PUBLISHER_ENABLED') === 'false';
  }

  isNetworkDisabled(): boolean {
    return this.isExplicitlyDisabled()
      || this.config.get<string>('PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE') === 'true';
  }

  private connection(namespace: PublisherNamespace): PublisherConnection | null {
    if (this.isNetworkDisabled()) return null;
    const baseUrl = this.baseUrl();
    const token = this.token(namespace);
    return baseUrl && token ? { baseUrl, token } : null;
  }

  private baseUrl(): string | null {
    const raw = this.config.get<string>('PUBLISHER_BASE_URL')?.trim();
    return raw ? raw.replace(/\/+$/, '') : null;
  }

  private token(namespace: PublisherNamespace): string | null {
    const cfg = NAMESPACE_CONFIG[namespace];
    return (
      this.config.get<string>(cfg.tokenEnv) ||
      (cfg.legacyTokenEnv ? this.config.get<string>(cfg.legacyTokenEnv) : undefined) ||
      this.config.get<string>('PUBLISHER_TOKEN') ||
      null
    );
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
}
