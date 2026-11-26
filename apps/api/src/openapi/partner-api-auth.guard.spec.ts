import { BadRequestException, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '@ruidong/shared';
import { PartnerApiAuthGuard } from './partner-api-auth.guard';

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('PartnerApiAuthGuard', () => {
  function buildGuard(product: unknown = { id: 'prod-1', slug: 'rdclaw' }) {
    const productAuth = {
      resolveFromHeaders: jest.fn().mockResolvedValue(product),
    };
    const redis = {
      eval: jest.fn().mockResolvedValue([1, 60_000]),
    };
    const config = {
      get: jest.fn(),
    };
    return {
      guard: new PartnerApiAuthGuard(
        productAuth as never,
        redis as never,
        config as never,
      ),
      productAuth,
      redis,
      config,
    };
  }

  it('attaches the product context resolved from the integration token', async () => {
    const { guard, productAuth, redis } = buildGuard();
    const req = { headers: { authorization: 'Bearer rpi_secret' }, query: {} };

    await expect(guard.canActivate(context(req))).resolves.toBe(true);

    expect(productAuth.resolveFromHeaders).toHaveBeenCalledWith(req.headers);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'openapi:rate-limit:product:prod-1',
      '60000',
    );
    expect(req).toMatchObject({ productContext: { id: 'prod-1', slug: 'rdclaw' } });
  });

  it('rejects requests without a valid product integration token', async () => {
    const { guard } = buildGuard(null);

    await expect(guard.canActivate(context({ headers: {}, query: {} }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects external product selectors', async () => {
    const { guard, productAuth } = buildGuard();

    await expect(guard.canActivate(context({
      headers: { authorization: 'Bearer rpi_secret' },
      query: { productSlug: 'other' },
    }))).rejects.toThrow(BadRequestException);
    expect(productAuth.resolveFromHeaders).not.toHaveBeenCalled();
  });

  it('enforces a shared per-product request limit after authentication', async () => {
    const { guard, redis, config } = buildGuard();
    config.get.mockImplementation((key: string) => {
      if (key === 'OPENAPI_PRODUCT_RATE_LIMIT_MAX') return '2';
      if (key === 'OPENAPI_PRODUCT_RATE_LIMIT_WINDOW_MS') return '10000';
      return undefined;
    });
    redis.eval.mockResolvedValue([3, 8_500]);

    await expect(guard.canActivate(context({
      headers: { authorization: 'Bearer rpi_secret' },
      query: {},
    }))).rejects.toMatchObject({
      response: expect.objectContaining({
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        retryAfter: 9,
      }),
      status: 429,
    });
  });

  it('fails closed when the product rate-limit store is unavailable', async () => {
    const { guard, redis } = buildGuard();
    redis.eval.mockRejectedValue(new Error('redis down'));

    await expect(guard.canActivate(context({
      headers: { authorization: 'Bearer rpi_secret' },
      query: {},
    }))).rejects.toMatchObject({ status: 503 });
  });

  it('fails closed when the limiter counter has no expiry', async () => {
    const { guard, redis } = buildGuard();
    redis.eval.mockResolvedValue([1, -1]);

    await expect(guard.canActivate(context({
      headers: { authorization: 'Bearer rpi_secret' },
      query: {},
    }))).rejects.toMatchObject({ status: 503 });
  });
});
