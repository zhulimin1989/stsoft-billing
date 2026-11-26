import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '@ruidong/shared';
import { FastifyRequest } from 'fastify';
import {
  ProductIntegrationAuthService,
  ProductIntegrationContext,
} from '../billing/product-integration-auth.service';
import { RedisService } from '../redis/redis.service';

type HeaderValue = string | string[] | undefined;

const PRODUCT_RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {current, redis.call('PTTL', KEYS[1])}
`;

export type PartnerApiRequest = FastifyRequest & {
  productContext?: ProductIntegrationContext;
};

@Injectable()
export class PartnerApiAuthGuard implements CanActivate {
  constructor(
    private readonly productAuth: ProductIntegrationAuthService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PartnerApiRequest>();
    this.rejectExternalProductSelectors(request);

    const product = await this.productAuth.resolveFromHeaders(
      request.headers as Record<string, HeaderValue>,
    );
    if (!product) {
      throw new UnauthorizedException('Missing or invalid product integration token');
    }

    await this.enforceProductRateLimit(product.id);
    request.productContext = product;
    return true;
  }

  private async enforceProductRateLimit(productId: string): Promise<void> {
    const max = this.positiveInt(
      this.config.get<string | number>('OPENAPI_PRODUCT_RATE_LIMIT_MAX'),
      600,
    );
    const windowMs = this.positiveInt(
      this.config.get<string | number>('OPENAPI_PRODUCT_RATE_LIMIT_WINDOW_MS'),
      60_000,
    );
    let result: unknown;
    try {
      result = await this.redis.eval(
        PRODUCT_RATE_LIMIT_SCRIPT,
        1,
        `openapi:rate-limit:product:${productId}`,
        String(windowMs),
      );
    } catch {
      // This public plane fails closed when its shared limiter is unavailable.
      throw new ServiceUnavailableException('Partner API rate limit backend unavailable');
    }

    if (!Array.isArray(result) || result.length < 2) {
      throw new ServiceUnavailableException('Partner API rate limit backend unavailable');
    }
    const count = Number(result[0]);
    const ttlMs = Number(result[1]);
    if (
      !Number.isInteger(count)
      || count < 1
      || !Number.isFinite(ttlMs)
      || ttlMs <= 0
    ) {
      throw new ServiceUnavailableException('Partner API rate limit backend unavailable');
    }
    if (count <= max) return;

    const retryAfter = Math.max(1, Math.ceil(ttlMs / 1000));
    throw new HttpException(
      {
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        message: `Product request rate limit exceeded; retry after ${retryAfter}s`,
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private positiveInt(value: string | number | undefined, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private rejectExternalProductSelectors(request: FastifyRequest): void {
    if (this.hasProductSelector(request.query) || this.hasProductSelector(request.body)) {
      throw new BadRequestException('product identity is derived from the integration token');
    }
  }

  private hasProductSelector(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.productId !== undefined || record.productSlug !== undefined;
  }
}
