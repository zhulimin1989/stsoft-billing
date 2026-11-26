import { test, expect } from '@playwright/test';

/**
 * Core liveness + readiness probe coverage.
 *
 * These two endpoints are what ALB/Docker healthcheck hits. A regression
 * here takes instances out of rotation in production, so guard explicitly.
 */

test.describe('Health endpoints', () => {
  test('GET /api/health/live returns alive status and uptime', async ({ request }) => {
    const res = await request.get('/api/health/live');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.status).toBe('alive');
    expect(typeof body.data.uptimeMs).toBe('number');
    expect(body.data.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  test('GET /api/health/ready returns 200 with checks when infra up', async ({ request }) => {
    const res = await request.get('/api/health/ready');
    // In CI the pg + redis service containers are healthy before this runs,
    // so ready must be 200. 503 here indicates a real readiness regression.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.checks.db.status).toBe('ok');
    expect(body.data.checks.redis.status).toBe('ok');
    expect(body.data.checks.db.latencyMs).toBeLessThan(500);
    expect(body.data.checks.redis.latencyMs).toBeLessThan(200);
  });

  test('legacy GET /api/health still works for old deploy scripts', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.checks).toBeDefined();
  });
});
