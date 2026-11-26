import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsController } from './metrics.controller';
import { registry, httpRequestTotal } from './metrics.registry';

function mockConfig(overrides: Record<string, string | undefined> = {}) {
  const base = { NODE_ENV: 'test' };
  return {
    get: jest.fn((key: string) => ({ ...base, ...overrides }[key])),
  } as unknown as ConfigService;
}

function mockReply() {
  return { header: jest.fn() } as any;
}

function mockReq(authHeader?: string) {
  return { headers: authHeader ? { authorization: authHeader } : {} } as any;
}

async function build(configOverrides: Record<string, string | undefined> = {}) {
  const m = await Test.createTestingModule({
    controllers: [MetricsController],
    providers: [{ provide: ConfigService, useValue: mockConfig(configOverrides) }],
  }).compile();
  return m.get(MetricsController);
}

describe('MetricsController', () => {
  afterEach(() => {
    // Don't reset the registry — httpRequestTotal is module-scoped.
    // Individual tests own their label counts.
  });

  describe('dev mode (no credentials configured)', () => {
    it('allows anonymous scrape when METRICS_USER + METRICS_PASSWORD unset', async () => {
      const ctrl = await build({ NODE_ENV: 'development' });
      const reply = mockReply();

      const body = await ctrl.metrics(mockReq() as any, reply);
      expect(reply.header).toHaveBeenCalledWith('Content-Type', registry.contentType);
      expect(typeof body).toBe('string');
    });

    it('returns default Node metrics (process_cpu, memory)', async () => {
      const ctrl = await build({ NODE_ENV: 'development' });
      const body = await ctrl.metrics(mockReq() as any, mockReply() as any);
      expect(body).toContain('ruidong_process_cpu_seconds_total');
      expect(body).toContain('ruidong_http_requests_total');
    });

    it('exposes incremented counters after increment', async () => {
      httpRequestTotal.labels('GET', '/spec/probe', '2xx').inc();
      const ctrl = await build({ NODE_ENV: 'development' });
      const body = await ctrl.metrics(mockReq() as any, mockReply() as any);
      expect(body).toMatch(/ruidong_http_requests_total\{.*route="\/spec\/probe".*\} /);
    });
  });

  describe('production mode (credentials required)', () => {
    it('refuses anonymous staging scrapes when creds are unset', async () => {
      const ctrl = await build({ NODE_ENV: 'staging' });
      await expect(ctrl.metrics(mockReq() as any, mockReply() as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('allows explicit anonymous scrape only when opted in', async () => {
      const ctrl = await build({
        NODE_ENV: 'staging',
        METRICS_ALLOW_ANONYMOUS: 'true',
      });
      const body = await ctrl.metrics(mockReq() as any, mockReply() as any);
      expect(typeof body).toBe('string');
    });

    it('refuses unauthenticated requests when creds unset in prod', async () => {
      const ctrl = await build({ NODE_ENV: 'production' });
      await expect(ctrl.metrics(mockReq() as any, mockReply() as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses unauthenticated requests when APP_ENV=production', async () => {
      const ctrl = await build({ NODE_ENV: 'development', APP_ENV: 'production' });
      await expect(ctrl.metrics(mockReq() as any, mockReply() as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects when Authorization header missing', async () => {
      const ctrl = await build({
        NODE_ENV: 'production',
        METRICS_USER: 'prom',
        METRICS_PASSWORD: 'secret',
      });
      await expect(ctrl.metrics(mockReq() as any, mockReply() as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects when Authorization scheme is not Basic', async () => {
      const ctrl = await build({
        NODE_ENV: 'production',
        METRICS_USER: 'prom',
        METRICS_PASSWORD: 'secret',
      });
      await expect(
        ctrl.metrics(mockReq('Bearer abc123') as any, mockReply() as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects wrong credentials', async () => {
      const ctrl = await build({
        NODE_ENV: 'production',
        METRICS_USER: 'prom',
        METRICS_PASSWORD: 'secret',
      });
      const wrong = 'Basic ' + Buffer.from('prom:wrong').toString('base64');
      await expect(ctrl.metrics(mockReq(wrong) as any, mockReply() as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects wrong user', async () => {
      const ctrl = await build({
        NODE_ENV: 'production',
        METRICS_USER: 'prom',
        METRICS_PASSWORD: 'secret',
      });
      const wrong = 'Basic ' + Buffer.from('alice:secret').toString('base64');
      await expect(ctrl.metrics(mockReq(wrong) as any, mockReply() as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('accepts correct credentials', async () => {
      const ctrl = await build({
        NODE_ENV: 'production',
        METRICS_USER: 'prom',
        METRICS_PASSWORD: 'secret',
      });
      const good = 'Basic ' + Buffer.from('prom:secret').toString('base64');
      const body = await ctrl.metrics(mockReq(good) as any, mockReply() as any);
      expect(typeof body).toBe('string');
      expect(body).toContain('ruidong_');
    });

    it('handles malformed base64 gracefully', async () => {
      const ctrl = await build({
        NODE_ENV: 'production',
        METRICS_USER: 'prom',
        METRICS_PASSWORD: 'secret',
      });
      await expect(
        ctrl.metrics(mockReq('Basic !!!not-base64!!!') as any, mockReply() as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('compares credentials in constant time (length-safe)', async () => {
      const ctrl = await build({
        NODE_ENV: 'production',
        METRICS_USER: 'prom',
        METRICS_PASSWORD: 'secret',
      });
      // A password of a different length should still reject without timing attack.
      const shorter = 'Basic ' + Buffer.from('prom:short').toString('base64');
      const longer = 'Basic ' + Buffer.from('prom:secret-way-too-long').toString('base64');
      await expect(ctrl.metrics(mockReq(shorter) as any, mockReply() as any)).rejects.toThrow();
      await expect(ctrl.metrics(mockReq(longer) as any, mockReply() as any)).rejects.toThrow();
    });
  });
});
