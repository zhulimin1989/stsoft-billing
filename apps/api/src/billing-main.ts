// MUST be first: Sentry's OpenTelemetry hooks only catch modules imported
// after init(). Any reorder here silently blinds error tracking.
import './instrument';

process.env.RUIDONG_SERVICE = 'billing';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { Readable } from 'stream';
import { BillingRuntimeModule } from './billing-runtime/billing-runtime.module';
import { registerSecurityPlugins } from './common/security/security.plugin';
import { resolveCorsOrigins } from './common/security/cors-origins';
import { isCsrfExemptPath } from './common/security/csrf-exempt-paths';
import { assertProductionSecrets } from './common/utils/assert-production-secrets';
import { shouldCapturePaymentNotifyRawBody } from './payment/payment-notify-paths';
import { RedisService } from './redis/redis.service';

async function bootstrap() {
  assertProductionSecrets();

  const app = await NestFactory.create<NestFastifyApplication>(
    BillingRuntimeModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: positiveInt(process.env.BILLING_BODY_LIMIT_BYTES, 10 * 1024 * 1024),
      requestTimeout: 60_000,
      keepAliveTimeout: 72_000,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const fastifyInstance = app.getHttpAdapter().getInstance();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await fastifyInstance.register(fastifyCookie as any, {
    secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await registerSecurityPlugins(fastifyInstance as any, {
    redis: app.get(RedisService),
  });

  fastifyInstance.addHook('preParsing', async (request: any, _reply: any, payload: any) => {
    if (!shouldCapturePaymentNotifyRawBody(request.url)) return payload;

    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks);
    request.rawBody = raw;
    return Readable.from(raw);
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
    prefix: 'v',
  });

  const corsOrigins = resolveCorsOrigins({
    names: ['BILLING_CORS_ORIGINS', 'CORS_ORIGINS'],
    devDefaults: ['http://localhost:5173', 'http://localhost:5174'],
    label: 'billing API',
  });
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  fastifyInstance.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (isCsrfExemptPath(request.url)) return;

    const origin = request.headers.origin;
    if (!origin || !corsOrigins.includes(origin)) {
      reply.code(403).send({ code: 403, message: 'Forbidden: origin mismatch', data: null });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('ruidong billing API')
      .setDescription('独立计费服务 — 订阅、订单、支付、余额、积分、账单')
      .setVersion('1.0.0')
      .addCookieAuth('access_token')
      .addCookieAuth('admin_access_token')
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'User JWT' })
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.BILLING_PORT || process.env.PORT || 3010;
  await app.listen(port, '0.0.0.0');
}

void bootstrap();

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
