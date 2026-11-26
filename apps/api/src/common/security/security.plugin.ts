import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RedisService } from '../../redis/redis.service';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { ErrorCode } from '@ruidong/shared';

/**
 * This needs to be an HttpException as well as a Fastify-shaped error.
 *
 * The global Fastify limiter runs before Nest's controller pipeline.  When
 * its Redis callback fails, Fastify forwards this error into Nest's global
 * exception filter for controller routes.  A plain Error with statusCode
 * would be reclassified by that filter as an undocumented 500.  Keeping the
 * statusCode makes bare Fastify deployments correct too, while extending
 * ServiceUnavailableException lets the Partner envelope filter retain 503.
 */
class RateLimitStoreUnavailableError extends ServiceUnavailableException {
  readonly statusCode = HttpStatus.SERVICE_UNAVAILABLE;
  readonly code = ErrorCode.SERVICE_UNAVAILABLE;

  constructor() {
    super({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Partner API rate limit backend unavailable',
    });
    this.name = 'RateLimitStoreUnavailableError';
  }
}

/**
 * @fastify/rate-limit throws the return value of errorResponseBuilder.  This
 * must therefore be a real HttpException, not merely an object shaped like a
 * Fastify error: otherwise Nest's global filter correctly treats it as an
 * unknown exception and returns a 500.  The own statusCode/code fields retain
 * the expected behavior for a bare Fastify instance as well.
 */
class RateLimitExceededError extends HttpException {
  readonly statusCode = HttpStatus.TOO_MANY_REQUESTS;
  readonly code = ErrorCode.RATE_LIMIT_EXCEEDED;

  constructor(readonly retryAfter: number) {
    super({
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
      message: `请求过于频繁，请 ${retryAfter} 秒后再试`,
      retryAfter,
    }, HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'RateLimitExceededError';
  }
}

function retryAfterSeconds(after: string): number {
  // @fastify/rate-limit exposes its retry delay as a human-readable `after`
  // string (for example "10 seconds" or "1 minute"), not the raw TTL.
  const match = /^(\d+(?:\.\d+)?)\s*(millisecond|second|minute|hour|day)s?$/i.exec(
    after.trim(),
  );
  if (!match) return 1;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 1;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith('millisecond')
    ? 1 / 1000
    : unit.startsWith('minute')
      ? 60
      : unit.startsWith('hour')
        ? 60 * 60
        : unit.startsWith('day')
          ? 24 * 60 * 60
          : 1;
  return Math.max(1, Math.ceil(amount * multiplier));
}

export const PARTNER_CACHE_CONTROL = 'private, no-store';
export const PARTNER_VARY_HEADERS = [
  'Authorization',
  'x-product-token',
  'x-billing-product-token',
] as const;

/**
 * Merge Vary values case-insensitively.  A response may already vary by
 * Origin (for CORS) or an application-specific selector; preserve those
 * dimensions while adding the credentials that select a Partner product.
 */
export function mergePartnerVaryHeader(existing: unknown): string {
  const current = typeof existing === 'string' ? existing.split(',') : [];
  const seen = new Set<string>();
  const values: string[] = [];

  for (const value of [...current, ...PARTNER_VARY_HEADERS]) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    values.push(trimmed);
  }
  return values.join(', ');
}

/**
 * Partner responses can contain product-specific billing state.  Never let a
 * shared browser/CDN cache reuse one product's response for another product.
 * This is deliberately registered only by the standalone OpenAPI bootstrap;
 * billing/admin traffic keeps its existing cache behavior.
 */
export async function registerPartnerTransportPolicy(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook('onSend', async (_request, reply: FastifyReply, payload) => {
    reply.header('Cache-Control', PARTNER_CACHE_CONTROL);
    reply.header('Vary', mergePartnerVaryHeader(reply.getHeader('Vary')));
    return payload;
  });
}

/**
 * @fastify/rate-limit otherwise rethrows the raw Redis error when skipOnError
 * is false, which Fastify/Nest exposes as an undocumented 500. Brand only the
 * limiter callback error as 503; all normal Redis behavior remains untouched.
 */
function failClosedRateLimitRedis(redis: RedisService): RedisService {
  return new Proxy(redis, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'rateLimit' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex];
        if (typeof callback !== 'function') {
          return value.apply(target, args);
        }
        args[callbackIndex] = (error: unknown, result: unknown) => {
          (callback as (error: unknown, result?: unknown) => void)(
            error ? new RateLimitStoreUnavailableError() : null,
            result,
          );
        };
        return value.apply(target, args);
      };
    },
  });
}

/**
 * Global security plugins for the Fastify adapter.
 *
 * Kept as a plain function (not a Nest module) so it can be composed in
 * main.ts next to the existing cookie/CORS/CSRF registrations, and so it
 * can be unit-tested against a bare Fastify instance without booting Nest.
 */

export interface SecurityOptions {
  /** ioredis-compatible client for the rate-limit store. Missing → in-memory store (single-instance only). */
  redis?: RedisService;
  /**
   * Ceiling for anonymous IPs. Can be overridden per-route via
   * `@RateLimit({ max, timeWindow })` decorator + Fastify hooks if needed.
   */
  globalMax?: number;
  globalTimeWindow?: string;
  /**
   * Whether rate-limit store failures should allow requests through.
   * Public API planes should set this to false; internal/dev planes may opt in.
   */
  skipOnRateLimitStoreError?: boolean;
  /**
   * Paths exempt from global rate-limit.
   * Exact by default; suffix `*` marks an intentional URL-prefix exemption.
   */
  exemptPaths?: string[];
  /** NODE_ENV passthrough — prod tightens helmet settings. */
  env?: string;
}

export const DEFAULT_SECURITY_OPTIONS: Required<
  Omit<SecurityOptions, 'redis' | 'env'>
> & { env: string } = {
  globalMax: 300,
  globalTimeWindow: '1 minute',
  skipOnRateLimitStoreError: true,
  exemptPaths: [
    // Metrics scrape from Prometheus (basic auth already gates it).
    '/api/metrics',
    // Liveness is process-local and cheap. Readiness hits DB/Redis and must
    // stay rate-limited when the route is externally reachable.
    '/api/health/live',
    // Payment provider callbacks — providers retry aggressively and
    // signature verification already guards against abuse.
    '/api/payment/notify/stripe',
    '/api/payment/notify/wechat',
    '/api/payment/notify/alipay',
    // Outbound webhook receivers (BullMQ-backed), signature-verified.
    '/api/webhooks/*',
  ],
  env: 'development',
};

export function resolveSecurityOptions(opts: SecurityOptions = {}): Required<
  Omit<SecurityOptions, 'redis'>
> & { redis?: RedisService } {
  return {
    ...DEFAULT_SECURITY_OPTIONS,
    env: opts.env ?? process.env.NODE_ENV ?? DEFAULT_SECURITY_OPTIONS.env,
    globalMax: opts.globalMax ?? DEFAULT_SECURITY_OPTIONS.globalMax,
    globalTimeWindow: opts.globalTimeWindow ?? DEFAULT_SECURITY_OPTIONS.globalTimeWindow,
    skipOnRateLimitStoreError:
      opts.skipOnRateLimitStoreError
      ?? DEFAULT_SECURITY_OPTIONS.skipOnRateLimitStoreError,
    exemptPaths: opts.exemptPaths ?? DEFAULT_SECURITY_OPTIONS.exemptPaths,
    redis: opts.redis,
  };
}

/**
 * A value of 0 means the OpenAPI process is directly reachable and must not
 * trust client-supplied X-Forwarded-* headers.  Positive values trust exactly
 * that many proxy hops; malformed/negative values fall back conservatively.
 */
export function resolveTrustedProxyHops(value: string | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function isExemptPath(url: string, exemptPaths: string[]): boolean {
  const path = url.split('?')[0] || url;
  return exemptPaths.some((p) => {
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      return path.startsWith(prefix);
    }
    return path === p;
  });
}

/**
 * Register @fastify/helmet and @fastify/rate-limit against a Fastify instance.
 *
 * Helmet default headers: X-Frame-Options=SAMEORIGIN, X-Content-Type-Options=nosniff,
 * Strict-Transport-Security (prod only), Referrer-Policy=no-referrer, hides X-Powered-By.
 * CSP is deliberately left off — the Nginx/ALB layer sets it (we'd conflict) and
 * Swagger UI in dev needs inline script/style.
 */
export async function registerSecurityPlugins(
  fastify: FastifyInstance,
  opts: SecurityOptions = {},
): Promise<void> {
  const resolved = resolveSecurityOptions(opts);
  const isProd = resolved.env === 'production';

  // ---- Helmet ----
  await fastify.register(fastifyHelmet as any, {
    // Let the edge (Nginx/ALB) own CSP so we don't double-ship policy.
    contentSecurityPolicy: false,
    // HSTS is only meaningful over HTTPS; enable in prod where TLS is guaranteed.
    strictTransportSecurity: isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    // X-Frame-Options + frame-ancestors handled by helmet defaults.
    frameguard: { action: 'sameorigin' },
  });

  // ---- Rate limit ----
  await fastify.register(fastifyRateLimit as any, {
    global: true,
    max: resolved.globalMax,
    timeWindow: resolved.globalTimeWindow,
    // Use Redis store when available so horizontal scaling shares counters.
    // Without it (single instance dev), fall back to the default memory store.
    redis:
      resolved.redis && !resolved.skipOnRateLimitStoreError
        ? failClosedRateLimitRedis(resolved.redis)
        : resolved.redis,
    // Exempt readiness, metrics, and payment callbacks. The fn returns true
    // to skip the limiter for this request.
    skipOnError: resolved.skipOnRateLimitStoreError,
    allowList: (req: FastifyRequest) => isExemptPath(req.url ?? '', resolved.exemptPaths),
    // Identify by IP. Respect x-forwarded-for because Fastify trustProxy is on.
    keyGenerator: (req: FastifyRequest) => req.ip,
    // @fastify/rate-limit throws this value.  Return an HttpException so the
    // Partner APP_FILTER preserves its 429 envelope instead of mapping the
    // otherwise plain object to INTERNAL_ERROR/500.
    errorResponseBuilder: (
      _req: FastifyRequest,
      ctx: { max: number; after: string },
    ) => new RateLimitExceededError(retryAfterSeconds(ctx.after)),
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });
}
