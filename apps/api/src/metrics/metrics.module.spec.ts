import { Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { billingUsageKafkaHmacVerificationsTotal, registry } from './metrics.registry';
import { MetricsModule } from './metrics.module';

@Controller('metrics-probe')
class MetricsProbeController {
  @Get(':id')
  get(): string {
    return 'ok';
  }
}

describe('MetricsModule HTTP binding', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'production',
              METRICS_USER: 'prom',
              METRICS_PASSWORD: 'secret',
            }),
          ],
        }),
        MetricsModule,
      ],
      controllers: [MetricsProbeController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves authenticated HMAC metrics only from /api/metrics', async () => {
    billingUsageKafkaHmacVerificationsTotal.labels('shadow', 'valid').inc();
    const fastify = app.getHttpAdapter().getInstance();

    const anonymous = await fastify.inject({ method: 'GET', url: '/api/metrics' });
    expect(anonymous.statusCode).toBe(401);

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: {
        authorization: `Basic ${Buffer.from('prom:secret').toString('base64')}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(registry.contentType);
    expect(response.body).toMatch(
      /ruidong_billing_usage_kafka_hmac_verifications_total\{mode="shadow",outcome="valid"\}\s+1/,
    );

    const unprefixed = await fastify.inject({ method: 'GET', url: '/metrics' });
    expect(unprefixed.statusCode).toBe(404);
  });

  it('uses the Fastify route template instead of resource IDs', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    for (const id of ['http-cardinality-a', 'http-cardinality-b']) {
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/metrics-probe/${id}`,
      });
      expect(response.statusCode).toBe(200);
    }

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: {
        authorization: `Basic ${Buffer.from('prom:secret').toString('base64')}`,
      },
    });
    expect(response.body).toContain('route="/api/metrics-probe/:id"');
    expect(response.body).not.toContain('http-cardinality-a');
    expect(response.body).not.toContain('http-cardinality-b');
  });
});
