import {
  BadGatewayException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type QueryValue = string | number | boolean | undefined | null;
type QueryParams = Record<string, QueryValue>;
type HeaderBag = Record<string, string | undefined | null>;

export type RawProxyResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host',
]);

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function derivePortalBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = trimTrailingSlash(value);
  if (trimmed.endsWith('/api/internal/billing/admin')) {
    return trimmed.slice(0, -'/internal/billing/admin'.length);
  }
  if (trimmed.endsWith('/internal/billing/admin')) {
    return trimmed.slice(0, -'/internal/billing/admin'.length);
  }
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

@Injectable()
export class BillingPortalClient {
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = trimTrailingSlash(
      this.config.get<string>('BILLING_PORTAL_SERVICE_URL') ||
        this.config.get<string>('BILLING_PUBLIC_SERVICE_URL') ||
        derivePortalBaseUrl(this.config.get<string>('BILLING_SERVICE_URL')) ||
        'http://localhost:3010/api',
    );
  }

  async requestEnvelope(
    method: string,
    path: string,
    query?: QueryParams,
    body?: unknown,
    headers?: HeaderBag,
  ): Promise<unknown> {
    const response = await this.fetchBilling(method, path, query, body, headers);
    const payload = await this.parseJson(response);
    if (!response.ok) {
      throw new HttpException(
        this.extractMessage(payload) ?? `billing service returned ${response.status}`,
        response.status,
      );
    }
    return payload;
  }

  async requestRaw(
    method: string,
    path: string,
    query?: QueryParams,
    body?: Buffer | string,
    headers?: HeaderBag,
  ): Promise<RawProxyResponse> {
    const response = await this.fetchBilling(method, path, query, body, headers, true);
    const arrayBuffer = await response.arrayBuffer();
    return {
      status: response.status,
      headers: this.responseHeaders(response),
      body: Buffer.from(arrayBuffer),
    };
  }

  private async fetchBilling(
    method: string,
    path: string,
    query?: QueryParams,
    body?: unknown,
    headers?: HeaderBag,
    rawBody = false,
  ): Promise<Response> {
    const url = this.buildUrl(path, query);
    const normalizedHeaders = this.normalizeHeaders(headers);
    if (!rawBody && body !== undefined && !normalizedHeaders['content-type']) {
      normalizedHeaders['content-type'] = 'application/json';
    }

    try {
      return await fetch(url, {
        method,
        headers: normalizedHeaders,
        body: body === undefined
          ? undefined
          : rawBody
            ? (body as BodyInit)
            : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch (err) {
      throw new BadGatewayException(
        `billing service unavailable: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private normalizeHeaders(headers?: HeaderBag): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!value) continue;
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      result[lower] = value;
    }
    return result;
  }

  private timeoutMs(): number {
    const raw = this.config.get<string | number>('BILLING_PORTAL_TIMEOUT_MS')
      ?? this.config.get<string | number>('BILLING_SERVICE_TIMEOUT_MS')
      ?? 10_000;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 10_000;
  }

  private responseHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(lower)) headers[lower] = value;
    });
    return headers;
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  private extractMessage(payload: unknown): string | null {
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const value = (payload as { message?: unknown }).message;
      return typeof value === 'string' ? value : null;
    }
    return null;
  }
}
