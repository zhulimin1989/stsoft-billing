import { Controller, Get, Req, Res, UnauthorizedException, Logger } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/decorators/public.decorator';
import { registry } from './metrics.registry';
import { timingSafeEqual } from 'node:crypto';
import { isProductionConfig } from '../common/runtime/is-production';

/**
 * /api/metrics — Prometheus scrape endpoint.
 *
 * Gated by HTTP basic auth so the endpoint isn't publicly scrapable.
 * In production, METRICS_USER and METRICS_PASSWORD must both be set;
 * otherwise the controller refuses every request with 401. In development
 * without creds configured, unauthenticated access is allowed so local
 * Prometheus can scrape during feature work.
 */
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);
  private readonly user: string | undefined;
  private readonly password: string | undefined;
  private readonly nodeEnv: string | undefined;
  private readonly isProd: boolean;
  private readonly allowAnonymous: boolean;

  constructor(config: ConfigService) {
    this.user = config.get<string>('METRICS_USER');
    this.password = config.get<string>('METRICS_PASSWORD');
    this.nodeEnv = config.get<string>('NODE_ENV');
    this.isProd = isProductionConfig(config);
    this.allowAnonymous = config.get<string>('METRICS_ALLOW_ANONYMOUS') === 'true';
  }

  @Public()
  @Get()
  async metrics(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    this.requireAuth(req);
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  }

  private requireAuth(req: FastifyRequest): void {
    if (!this.user || !this.password) {
      if (!this.isProd && (this.nodeEnv === 'development' || this.allowAnonymous)) return;
      this.logger.warn('METRICS_USER/METRICS_PASSWORD not set — refusing anonymous scrape');
      throw new UnauthorizedException();
    }

    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Basic ')) {
      throw new UnauthorizedException();
    }

    let user: string;
    let pass: string;
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
      const idx = decoded.indexOf(':');
      user = decoded.slice(0, idx);
      pass = decoded.slice(idx + 1);
    } catch {
      throw new UnauthorizedException();
    }

    if (!safeEqual(user, this.user) || !safeEqual(pass, this.password)) {
      throw new UnauthorizedException();
    }
  }
}

// Constant-time string compare to avoid timing attacks on the metrics credential.
function safeEqual(a: string, b: string): boolean {
  const abuf = Buffer.from(a);
  const bbuf = Buffer.from(b);
  if (abuf.length !== bbuf.length) return false;
  return timingSafeEqual(abuf, bbuf);
}
