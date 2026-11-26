import { createHash } from 'crypto';
import { ProductIntegrationAuthService } from './product-integration-auth.service';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('ProductIntegrationAuthService', () => {
  const prisma = {
    product: {
      findFirst: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a product from x-product-token', async () => {
    const service = new ProductIntegrationAuthService(prisma as any);
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'rdclaw',
      name: 'RDClaw',
      billingMode: 'SUBSCRIPTION',
      allowedPaymentCallbackOrigins: ['https://product.example.com/'],
    });

    const result = await service.resolveFromHeaders({ 'x-product-token': 'rpi_secret' });

    expect(result?.slug).toBe('rdclaw');
    expect(result?.allowedPaymentCallbackOrigins).toEqual(['https://product.example.com']);
    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { integrationTokenHash: hash('rpi_secret'), isActive: true, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        billingMode: true,
        allowedPaymentCallbackOrigins: true,
      },
    });
  });

  it('accepts a bearer token', async () => {
    const service = new ProductIntegrationAuthService(prisma as any);
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'rdclaw',
      name: 'RDClaw',
      billingMode: 'SUBSCRIPTION',
      allowedPaymentCallbackOrigins: null,
    });

    await service.resolveFromHeaders({ authorization: 'Bearer rpi_secret' });

    expect(prisma.product.findFirst.mock.calls[0][0].where.integrationTokenHash).toBe(hash('rpi_secret'));
  });

  it('accepts the same credential repeated across compatibility headers', async () => {
    const service = new ProductIntegrationAuthService(prisma as any);
    prisma.product.findFirst.mockResolvedValue(null);

    await service.resolveFromHeaders({
      'x-product-token': 'rpi_secret',
      authorization: 'Bearer rpi_secret',
    });

    expect(prisma.product.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting authentication headers before querying a product', async () => {
    const service = new ProductIntegrationAuthService(prisma as any);

    await expect(service.resolveFromHeaders({
      'x-product-token': 'product-a-token',
      authorization: 'Bearer product-b-token',
    })).resolves.toBeNull();

    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it('fails closed when the stored product callback setting is not an array', async () => {
    const service = new ProductIntegrationAuthService(prisma as any);
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'rdclaw',
      name: 'RDClaw',
      billingMode: 'SUBSCRIPTION',
      allowedPaymentCallbackOrigins: { origin: 'https://product.example.com' },
    });

    await expect(service.resolveToken('rpi_secret')).resolves.toMatchObject({
      allowedPaymentCallbackOrigins: [],
    });
  });

  it('returns null when no product token header is present', async () => {
    const service = new ProductIntegrationAuthService(prisma as any);

    await expect(service.resolveFromHeaders({})).resolves.toBeNull();
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });
});
