import Fastify, { FastifyInstance } from 'fastify';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import {
  PARTNER_CACHE_CONTROL,
  registerSecurityPlugins,
  registerPartnerTransportPolicy,
  resolveSecurityOptions,
  isExemptPath,
  DEFAULT_SECURITY_OPTIONS,
  mergePartnerVaryHeader,
  resolveTrustedProxyHops,
} from './security.plugin';

@Controller('partner/v1')
class TransportProbeController {
  @Get('transport-probe')
  probe() {
    return { code: 0, message: 'ok', data: null };
  }

  @Post('transport-probe')
  postProbe(@Body() body: unknown) {
    return { code: 0, message: 'ok', data: body };
  }
}

@Module({
  controllers: [TransportProbeController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
class TransportProbeModule {}

describe('resolveSecurityOptions', () => {
  it('fills defaults when no opts passed', () => {
    const resolved = resolveSecurityOptions({ env: 'test' });
    expect(resolved.globalMax).toBe(DEFAULT_SECURITY_OPTIONS.globalMax);
    expect(resolved.globalTimeWindow).toBe(DEFAULT_SECURITY_OPTIONS.globalTimeWindow);
    expect(resolved.skipOnRateLimitStoreError).toBe(true);
    expect(resolved.exemptPaths).toEqual(DEFAULT_SECURITY_OPTIONS.exemptPaths);
  });

  it('respects overrides', () => {
    const resolved = resolveSecurityOptions({
      env: 'production',
      globalMax: 50,
      globalTimeWindow: '10 seconds',
      skipOnRateLimitStoreError: false,
      exemptPaths: ['/ping'],
    });
    expect(resolved.globalMax).toBe(50);
    expect(resolved.globalTimeWindow).toBe('10 seconds');
    expect(resolved.skipOnRateLimitStoreError).toBe(false);
    expect(resolved.exemptPaths).toEqual(['/ping']);
    expect(resolved.env).toBe('production');
  });
});

describe('resolveTrustedProxyHops', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['2', 2],
    [undefined, 0],
    ['-1', 0],
    ['1.5', 0],
    ['not-a-number', 0],
  ])('resolves %s to %d trusted proxy hops', (value, expected) => {
    expect(resolveTrustedProxyHops(value)).toBe(expected);
  });
});

describe('isExemptPath', () => {
  const paths = [
    '/api/metrics',
    '/api/health/live',
    '/api/payment/notify/stripe',
    '/api/payment/notify/wechat',
    '/api/payment/notify/alipay',
    '/api/webhooks/*',
  ];

  it.each([
    ['/api/metrics', true],
    ['/api/metrics?x=1', true],
    ['/metrics', false],
    ['/api/health/live', true],
    ['/api/health', false],
    ['/api/health/ready', false],
    ['/api/payment/notify/wechat', true],
    ['/api/payment/notify/wechat?x=1', true],
    ['/api/payment/notify/wechat/extra', false],
    ['/api/payment/notify-attacker/wechat', false],
    ['/api/webhooks/abc', true],
    ['/api/user', false],
    ['/api/auth/login', false],
    ['/', false],
  ])('exempt(%s) === %s', (url, expected) => {
    expect(isExemptPath(url, paths)).toBe(expected);
  });
});

describe('Partner transport policy', () => {
  it('merges all credential selectors into Vary without dropping existing dimensions', () => {
    expect(mergePartnerVaryHeader('Origin, authorization')).toBe(
      'Origin, authorization, x-product-token, x-billing-product-token',
    );
  });

  it('sets no-store and Vary on successful and error responses', async () => {
    const app = Fastify();
    await registerPartnerTransportPolicy(app);
    app.get('/partner/v1/probe', async (_request, reply) => {
      reply.header('Vary', 'Origin');
      return { ok: true };
    });
    app.get('/partner/v1/error', async () => {
      throw new Error('probe failure');
    });
    await app.ready();

    for (const url of ['/partner/v1/probe', '/partner/v1/error']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.headers['cache-control']).toBe(PARTNER_CACHE_CONTROL);
      expect(response.headers.vary?.toLowerCase()).toContain('authorization');
      expect(response.headers.vary?.toLowerCase()).toContain('x-product-token');
      expect(response.headers.vary?.toLowerCase()).toContain('x-billing-product-token');
    }
    await app.close();
  });
});

// ---- Integration: register against a bare Fastify instance ----
describe('registerSecurityPlugins (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ trustProxy: true });
    // Plugins MUST register before route definitions. Fastify's onRequest hooks
    // only attach to routes registered after the plugin — exactly how main.ts
    // bootstraps (helmet+rate-limit before Nest builds controllers).
    await registerSecurityPlugins(app, {
      env: 'test',
      globalMax: 3,
      globalTimeWindow: '10 seconds',
    });

    app.get('/foo', async () => ({ ok: true }));
    app.get('/api/metrics', async () => ({ ok: true }));
    app.post('/api/payment/notify/wechat', async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets security response headers on every request', async () => {
    const res = await app.inject({ method: 'GET', url: '/foo' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toMatch(/SAMEORIGIN/i);
    // HSTS off outside prod
    expect(res.headers['strict-transport-security']).toBeUndefined();
    // x-powered-by should be stripped by helmet
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('enables HSTS in production', async () => {
    const prodApp = Fastify({ trustProxy: true });
    await registerSecurityPlugins(prodApp, { env: 'production', globalMax: 100 });
    prodApp.get('/foo', async () => ({ ok: true }));
    await prodApp.ready();

    const res = await prodApp.inject({ method: 'GET', url: '/foo' });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    await prodApp.close();
  });

  it('rate-limits anonymous IPs at the global ceiling', async () => {
    // 3 allowed, 4th should 429
    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({ method: 'GET', url: '/foo' });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: 'GET', url: '/foo' });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json();
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.message).toContain('请求过于频繁');
    // Fastify's default error serializer intentionally omits custom error
    // fields; the real Partner Nest transport test below asserts the full
    // envelope.  The standard retry header remains available here as well.
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('adds rate-limit response headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/foo' });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('fails closed as 503 when the shared rate-limit store is unavailable', async () => {
    const failingRedis = {
      defineCommand(name: string) {
        (this as Record<string, unknown>)[name] = (
          ...args: Array<unknown>
        ) => {
          const callback = args.at(-1) as (error: Error) => void;
          callback(new Error('redis unavailable'));
        };
      },
    };
    const failClosedApp = Fastify();
    await registerSecurityPlugins(failClosedApp, {
      env: 'test',
      redis: failingRedis as never,
      skipOnRateLimitStoreError: false,
    });
    failClosedApp.get('/foo', async () => ({ ok: true }));
    await failClosedApp.ready();

    const response = await failClosedApp.inject({ method: 'GET', url: '/foo' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Partner API rate limit backend unavailable',
    });
    await failClosedApp.close();
  });

  it('keeps a failed global Redis limiter as a Partner 503 envelope through Nest', async () => {
    const failingRedis = {
      defineCommand(name: string) {
        (this as Record<string, unknown>)[name] = (
          ...args: Array<unknown>
        ) => {
          const callback = args.at(-1) as (error: Error) => void;
          callback(new Error('redis unavailable'));
        };
      },
    };
    const nestApp = await NestFactory.create<NestFastifyApplication>(
      TransportProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    const fastify = nestApp.getHttpAdapter().getInstance() as FastifyInstance;
    await registerSecurityPlugins(fastify, {
      env: 'test',
      redis: failingRedis as never,
      skipOnRateLimitStoreError: false,
    });
    await registerPartnerTransportPolicy(fastify);
    await nestApp.init();

    const response = await fastify.inject({
      method: 'GET',
      url: '/partner/v1/transport-probe',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Partner API rate limit backend unavailable',
      data: null,
    });
    expect(response.headers['cache-control']).toBe(PARTNER_CACHE_CONTROL);
    expect(response.headers.vary?.toLowerCase()).toContain('authorization');
    await nestApp.close();
  });

  it('keeps a global limit exceed as a Partner 429 envelope through Nest', async () => {
    const nestApp = await NestFactory.create<NestFastifyApplication>(
      TransportProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    const fastify = nestApp.getHttpAdapter().getInstance() as FastifyInstance;
    await registerSecurityPlugins(fastify, {
      env: 'test',
      globalMax: 1,
      globalTimeWindow: '10 seconds',
      exemptPaths: [],
    });
    await registerPartnerTransportPolicy(fastify);
    await nestApp.init();

    const first = await fastify.inject({
      method: 'GET',
      url: '/partner/v1/transport-probe',
    });
    const limited = await fastify.inject({
      method: 'GET',
      url: '/partner/v1/transport-probe',
    });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(body).toEqual({
      code: 'RATE_LIMIT_EXCEEDED',
      message: expect.stringContaining('请求过于频繁'),
      data: null,
      statusCode: 429,
      retryAfter: expect.any(Number),
    });
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBe(String(body.retryAfter));
    expect(limited.headers['cache-control']).toBe(PARTNER_CACHE_CONTROL);
    await nestApp.close();
  });

  it('maps Fastify 413 and 415 parser failures to stable Partner envelopes', async () => {
    const nestApp = await NestFactory.create<NestFastifyApplication>(
      TransportProbeModule,
      new FastifyAdapter({ bodyLimit: 32 }),
      { logger: false },
    );
    const fastify = nestApp.getHttpAdapter().getInstance() as FastifyInstance;
    await registerSecurityPlugins(fastify, {
      env: 'test',
      globalMax: 100,
      exemptPaths: [],
    });
    await registerPartnerTransportPolicy(fastify);
    await nestApp.init();

    const tooLarge = await fastify.inject({
      method: 'POST',
      url: '/partner/v1/transport-probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'x'.repeat(128) }),
    });
    const unsupportedMediaType = await fastify.inject({
      method: 'POST',
      url: '/partner/v1/transport-probe',
      headers: { 'content-type': 'application/xml' },
      payload: '<value>ok</value>',
    });

    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({
      code: 'VALIDATION_ERROR',
      message: '请求体过大',
      data: null,
    });
    expect(unsupportedMediaType.statusCode).toBe(415);
    expect(unsupportedMediaType.json()).toEqual({
      code: 'VALIDATION_ERROR',
      message: '不支持的 Content-Type',
      data: null,
    });
    for (const response of [tooLarge, unsupportedMediaType]) {
      expect(response.headers['cache-control']).toBe(PARTNER_CACHE_CONTROL);
      expect(response.headers.vary?.toLowerCase()).toContain('authorization');
    }
    await nestApp.close();
  });

  it('exempts /api/metrics from rate-limit', async () => {
    // 10 calls >> limit of 3, all should 200
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/metrics' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('exempts payment callbacks from rate-limit', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/payment/notify/wechat',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
