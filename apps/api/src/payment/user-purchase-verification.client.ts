import {
  BadGatewayException,
  HttpException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_INTERNAL_API_VERSION = '2026-05-16';
const INTERNAL_API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS = 10_000;
const LOCAL_USER_SERVICE_URL = 'http://localhost:3000/api/internal/user/admin';
const DOCKER_USER_SERVICE_URL = 'http://user-api:3000/api/internal/user/admin';

export type FinanceUserContact = {
  id: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveInternalApiVersion(value: string | undefined): string {
  const version = value?.trim() || DEFAULT_INTERNAL_API_VERSION;
  if (!INTERNAL_API_VERSION_PATTERN.test(version)) {
    throw new Error('BILLING_INTERNAL_API_VERSION must use YYYY-MM-DD format');
  }
  return version;
}

function resolveInternalRequestTimeoutMs(value: string | undefined): number {
  const timeout = Number.parseInt(value || '', 10);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS;
}

function isProductionLike(config: ConfigService): boolean {
  const nodeEnv = config.get<string>('NODE_ENV')?.trim();
  const appEnv = config.get<string>('APP_ENV')?.trim();
  return nodeEnv === 'production' || appEnv === 'production';
}

export function resolveUserServiceBaseUrl(config: ConfigService): string {
  const configured = config.get<string>('USER_SERVICE_URL')?.trim();
  return trimTrailingSlash(
    configured || (isProductionLike(config) ? DOCKER_USER_SERVICE_URL : LOCAL_USER_SERVICE_URL),
  );
}

@Injectable()
export class UserPurchaseVerificationClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly apiVersion: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = resolveUserServiceBaseUrl(this.config);
    this.token = this.config.get<string>('BILLING_TO_USER_TOKEN')?.trim();
    this.apiVersion = resolveInternalApiVersion(
      this.config.get<string>('BILLING_INTERNAL_API_VERSION'),
    );
    this.requestTimeoutMs = resolveInternalRequestTimeoutMs(
      this.config.get<string>('INTERNAL_SERVICE_TIMEOUT_MS'),
    );
  }

  async assertCanPurchase(userId: string, tenantId: string): Promise<void> {
    await this.request(
      'POST',
      `/users/${encodeURIComponent(userId)}/purchase-eligibility/assert-v2`,
      { tenantId },
    );
  }

  async findFinanceUserIdsByContact(value: string): Promise<string[]> {
    const payload = await this.request('POST', '/users/finance-search-ids', { value });
    const data = this.envelopeData(payload);
    if (!data || typeof data !== 'object' || !Array.isArray((data as { ids?: unknown }).ids)) {
      throw new BadGatewayException('user service returned invalid finance search ids');
    }
    return Array.from(new Set(
      (data as { ids: unknown[] }).ids
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ));
  }

  async getFinanceUserContactsByIds(ids: string[]): Promise<FinanceUserContact[]> {
    const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    const batches: string[][] = [];
    for (let offset = 0; offset < unique.length; offset += 200) {
      batches.push(unique.slice(offset, offset + 200));
    }
    const contacts: FinanceUserContact[] = [];
    for (let offset = 0; offset < batches.length; offset += 4) {
      const group = await Promise.all(batches.slice(offset, offset + 4).map(async (batch) => {
        const payload = await this.request('POST', '/users/finance-contacts-by-ids', {
          ids: batch,
        });
        const data = this.envelopeData(payload);
        if (!data || typeof data !== 'object' || !Array.isArray((data as { items?: unknown }).items)) {
          throw new BadGatewayException('user service returned invalid finance contacts');
        }
        const result: FinanceUserContact[] = [];
        for (const item of (data as { items: unknown[] }).items) {
          if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') {
            throw new BadGatewayException('user service returned invalid finance contact');
          }
          const row = item as Record<string, unknown>;
          result.push({
            id: row.id as string,
            email: typeof row.email === 'string' ? row.email : null,
            phone: typeof row.phone === 'string' ? row.phone : null,
            nickname: typeof row.nickname === 'string' ? row.nickname : null,
          });
        }
        return result;
      }));
      contacts.push(...group.flat());
    }
    return contacts;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.token) {
      throw new InternalServerErrorException('BILLING_TO_USER_TOKEN is required');
    }
    const hasBody = body !== undefined;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-internal-caller': 'billing-api',
          'x-internal-token': this.token,
          'x-billing-api-version': this.apiVersion,
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new BadGatewayException(
        `user service unavailable: ${(err as Error)?.message ?? err}`,
      );
    }

    const payload = await this.parseJson(response);
    if (!response.ok) {
      throw new HttpException(
        payload ?? { message: `user service returned ${response.status}` },
        response.status,
      );
    }

    if (payload && typeof payload === 'object' && 'code' in payload) {
      const envelope = payload as { code?: number; message?: string };
      if (envelope.code !== 0) {
        throw new BadGatewayException(envelope.message || 'user service returned an error');
      }
    }
    return payload;
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

  private envelopeData(payload: unknown): unknown {
    return payload && typeof payload === 'object' && 'data' in payload
      ? (payload as { data?: unknown }).data
      : null;
  }
}
