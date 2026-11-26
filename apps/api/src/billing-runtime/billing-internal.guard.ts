import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { verifySignedAdminContext } from '../common/internal-auth/signed-admin-context';

const DEFAULT_BILLING_INTERNAL_API_VERSION = '2026-05-16';
const BILLING_INTERNAL_API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ADMIN_CONTEXT_TTL_SECONDS = 300;
type InternalCaller = 'admin-api' | 'user-api';

const CALLER_TOKEN_ENV: Record<InternalCaller, string> = {
  'admin-api': 'ADMIN_TO_BILLING_TOKEN',
  'user-api': 'USER_TO_BILLING_TOKEN',
};

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function safeTokenEqual(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizedPathname(url: string): string {
  try {
    const pathname = new URL(url || '/', 'http://billing.internal').pathname;
    const withoutApiPrefix = pathname.startsWith('/api/')
      ? pathname.slice('/api'.length)
      : pathname;
    return withoutApiPrefix.replace(/\/+$/, '') || '/';
  } catch {
    return '/';
  }
}

function internalCaller(value: string | null): InternalCaller | null {
  return value === 'admin-api' || value === 'user-api' ? value : null;
}

function methodOf(request: FastifyRequest): string {
  return String(request.method || 'GET').toUpperCase();
}

function userApiCanAccessBillingRoute(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/internal/billing/admin/products/default') return true;
  if (method === 'GET' && pathname === '/internal/billing/admin/api-keys/mirror') return true;
  if (method === 'PUT' && /^\/internal\/billing\/admin\/api-keys\/[^/]+\/mirror$/.test(pathname)) return true;
  if (method === 'DELETE' && /^\/internal\/billing\/admin\/api-keys\/[^/]+\/mirror$/.test(pathname)) return true;
  if (method === 'GET' && /^\/internal\/billing\/admin\/coding-plan\/entitlements\/[^/]+$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/api-keys/spend') return true;
  if (method === 'GET' && pathname === '/internal/billing/admin/payg-model-pricing') return true;
  if (method === 'GET' && pathname === '/internal/billing/admin/model-pricing') return true;
  if (method === 'POST' && /^\/internal\/billing\/admin\/users\/[^/]+\/ensure-default-free-plan$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/referrals/attribute') return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/referrals/click') return true;
  if (method === 'GET' && /^\/internal\/billing\/admin\/users\/[^/]+\/balance$/.test(pathname)) return true;
  if (method === 'GET' && /^\/internal\/billing\/admin\/users\/[^/]+\/credit-overview$/.test(pathname)) return true;
  if (method === 'PUT' && /^\/internal\/billing\/admin\/users\/[^/]+\/mirror$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/workspaces/mirror') return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/workspaces/balances') return true;
  if (method === 'PUT' && /^\/internal\/billing\/admin\/workspaces\/[^/]+\/allowance$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/usage/api-key-stats') return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/usage/token-usage') return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/usage/token-usage-summary') return true;
  if (method === 'GET' && /^\/internal\/billing\/account\/users\/[^/]+\/recent-orders$/.test(pathname)) return true;
  // 企业账户 user-api 自助端点白名单（§10.2.5）。仅 create / owner-members / attach-tenant；
  // list(GET /)、PUT(改快照)、detach-tenant 不放行。
  if (method === 'POST' && pathname === '/internal/billing/admin/enterprise-accounts') return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/enterprise-accounts/subject-check') return true;
  if (method === 'POST' && pathname === '/internal/billing/admin/enterprise-accounts/provisioning-proof') return true;
  if (method === 'POST' && /^\/internal\/billing\/admin\/enterprise-accounts\/[^/]+\/owner-members$/.test(pathname)) return true;
  if (method === 'POST' && /^\/internal\/billing\/admin\/enterprise-accounts\/[^/]+\/transfer-owner$/.test(pathname)) return true;
  if (method === 'POST' && /^\/internal\/billing\/admin\/enterprise-accounts\/[^/]+\/attach-tenant$/.test(pathname)) return true;
  // 议题二批一：回收写入口 + 两个只读端点。漏加任一条 ⇒ user-api 侧稳定 403
  // （void-provisioning 是**单调收缩**操作：只回收、永不激活或绑定）。
  if (method === 'POST' && pathname === '/internal/billing/admin/enterprise-accounts/void-provisioning') return true;
  if (method === 'GET' && pathname === '/internal/billing/admin/enterprise-accounts/reconcile') return true;
  if (method === 'GET' && pathname === '/internal/billing/admin/enterprise-accounts/hazards') return true;
  return false;
}

function callerCanAccessRoute(caller: InternalCaller, method: string, url: string): boolean {
  const pathname = normalizedPathname(url);
  if (caller === 'admin-api') {
    return pathname === '/internal/billing/admin' ||
      pathname.startsWith('/internal/billing/admin/');
  }
  return userApiCanAccessBillingRoute(method, pathname);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class BillingInternalGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const caller = internalCaller(firstHeader(request.headers['x-internal-caller'])?.trim() || null);
    const actual = firstHeader(request.headers['x-internal-token']);
    if (caller || actual) {
      return this.authenticateInternalCaller(request, caller, actual);
    }

    throw new UnauthorizedException('Missing billing internal credentials');
  }

  private authenticateInternalCaller(
    request: FastifyRequest,
    caller: InternalCaller | null,
    actual: string | null,
  ): boolean {
    if (!caller) {
      throw new UnauthorizedException('Invalid internal caller');
    }
    const expectedEnv = CALLER_TOKEN_ENV[caller];
    const expected = this.config.get<string>(expectedEnv)?.trim();
    if (!expected) {
      throw new UnauthorizedException(`${expectedEnv} is not configured`);
    }
    if (!safeTokenEqual(actual, expected)) {
      throw new UnauthorizedException('Invalid internal token');
    }
    this.ensureApiVersion(request);
    if (!callerCanAccessRoute(caller, methodOf(request), String(request.url || ''))) {
      throw new UnauthorizedException('Internal caller is not allowed for this route');
    }
    (request as any).internalCaller = caller;
    if (caller === 'admin-api') {
      const adminContext = verifySignedAdminContext(
        request.headers as Record<string, string | string[] | undefined>,
        this.config.get<string>('ADMIN_TO_BILLING_CONTEXT_SECRET'),
        { ttlSeconds: positiveInt(
          this.config.get<string>('INTERNAL_ADMIN_CONTEXT_TTL_SECONDS'),
          DEFAULT_ADMIN_CONTEXT_TTL_SECONDS,
        ) },
      );
      (request as any).adminContext = adminContext;
      (request as any).user = {
        id: adminContext.adminId,
        presetRole: adminContext.presetRole,
        adminPermissions: adminContext.permissions,
      };
    }
    return true;
  }

  private ensureApiVersion(request: FastifyRequest): void {
    const accepted = this.acceptedApiVersions();
    const actual = firstHeader(request.headers['x-billing-api-version']);
    if (!actual || !accepted.includes(actual)) {
      throw new BadRequestException('Unsupported billing internal API version');
    }
  }

  private acceptedApiVersions(): string[] {
    const primary =
      this.config.get<string>('BILLING_INTERNAL_API_VERSION')?.trim() ||
      DEFAULT_BILLING_INTERNAL_API_VERSION;
    const extra = (this.config.get<string>('BILLING_INTERNAL_ACCEPTED_API_VERSIONS') || '')
      .split(',')
      .map((version) => version.trim())
      .filter(Boolean);
    const versions = [...new Set([primary, ...extra])];
    for (const version of versions) {
      if (!BILLING_INTERNAL_API_VERSION_PATTERN.test(version)) {
        throw new Error('BILLING_INTERNAL_API_VERSION must use YYYY-MM-DD format');
      }
    }
    return versions;
  }
}
