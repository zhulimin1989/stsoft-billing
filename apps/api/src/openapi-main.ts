import './instrument';

process.env.RUIDONG_SERVICE = 'openapi';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import type { FastifyInstance } from 'fastify';
import { OpenApiModule } from './openapi/openapi.module';
import {
  assertPartnerOpenApiDocument,
  buildPartnerOpenApiDocument,
} from './openapi/partner-api.contract';
import {
  registerPartnerTransportPolicy,
  registerSecurityPlugins,
  resolveTrustedProxyHops,
} from './common/security/security.plugin';
import { RedisService } from './redis/redis.service';
import { assertProductionSecrets } from './common/utils/assert-production-secrets';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function bootstrap() {
  assertProductionSecrets();

  const app = await NestFactory.create<NestFastifyApplication>(
    OpenApiModule,
    new FastifyAdapter({
      // Trust only the configured number of edge hops. `true` would accept a
      // client-supplied X-Forwarded-For chain and make IP throttling spoofable.
      // Fail safe when no deployment topology is declared: a directly
      // exposed instance must not trust client-supplied forwarding headers.
      trustProxy: resolveTrustedProxyHops(process.env.OPENAPI_TRUST_PROXY_HOPS, 0),
      bodyLimit: positiveInt(process.env.OPENAPI_BODY_LIMIT_BYTES, 1024 * 1024),
      requestTimeout: positiveInt(process.env.OPENAPI_REQUEST_TIMEOUT_MS, 30_000),
      keepAliveTimeout: positiveInt(process.env.OPENAPI_KEEP_ALIVE_TIMEOUT_MS, 72_000),
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const fastifyInstance = app.getHttpAdapter().getInstance();
  await registerSecurityPlugins(fastifyInstance as unknown as FastifyInstance, {
    redis: app.get(RedisService),
    globalMax: positiveInt(process.env.OPENAPI_RATE_LIMIT_MAX, 120),
    globalTimeWindow: process.env.OPENAPI_RATE_LIMIT_WINDOW || '1 minute',
    skipOnRateLimitStoreError: false,
    // Liveness is process-local and cheap. Readiness performs DB/Redis I/O,
    // so it remains rate-limited like every other externally reachable read.
    exemptPaths: ['/health/live', '/docs*', '/openapi.json'],
  });
  // This process serves only the Partner/OpenAPI plane.  Install the policy
  // before Nest initializes routes so both successful and error responses are
  // non-cacheable and vary by product credentials.
  await registerPartnerTransportPolicy(fastifyInstance as unknown as FastifyInstance);

  if (process.env.NODE_ENV !== 'production' || process.env.OPENAPI_DOCS_ENABLED === 'true') {
    const document = buildPartnerOpenApiDocument(
      process.env.PARTNER_API_PUBLIC_BASE_URL ?? process.env.OPENAPI_PUBLIC_BASE_URL,
    );
    assertPartnerOpenApiDocument(document);
    SwaggerModule.setup('docs', app, document);
    fastifyInstance.get('/openapi.json', async () => document);
  }

  const port = process.env.OPENAPI_PORT || process.env.PORT || 3030;
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
