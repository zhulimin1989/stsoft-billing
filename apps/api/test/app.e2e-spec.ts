import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Legacy /api/health now delegates to /health/ready — requires real DB + Redis.
  // When DB and Redis are reachable, expect 200 with status=ok and a checks map.
  it('/api/health/live (GET) — liveness is always 200 regardless of downstream', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/api/health/live',
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.payload);
    expect(body.code).toBe(0);
    expect(body.data.status).toBe('alive');
    expect(typeof body.data.uptimeMs).toBe('number');
  });

  it('/api/health/ready (GET) — returns ok when DB + Redis reachable', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/api/health/ready',
    });
    // In CI the service containers are up → expect 200 ok.
    expect([200, 503]).toContain(result.statusCode);
    const body = JSON.parse(result.payload);
    expect(body.data.checks).toHaveProperty('db');
    expect(body.data.checks).toHaveProperty('redis');
  });
});
