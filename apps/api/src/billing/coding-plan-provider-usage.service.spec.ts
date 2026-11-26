import { ConfigService } from '@nestjs/config';
import { encrypt } from '../common/utils/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CodingPlanProviderAdapterRegistry } from './coding-plan-provider-adapter.registry';
import { CodingPlanProviderLineService } from './coding-plan-provider-line.service';
import { CodingPlanProviderUsageService } from './coding-plan-provider-usage.service';

describe('CodingPlanProviderUsageService', () => {
  const encryptionKey = 'a'.repeat(64);

  it('passes decrypted upstream credentials to provider usage adapters', async () => {
    const providerEntitlement = {
      id: 'provider-entitlement-1',
      status: 'ACTIVE',
      providerLineId: 'line-1',
      providerLineCode: 'line-code',
      adapterType: 'zhipu_partner',
      upstreamProductId: 'upstream-1',
      upstreamOrderId: 'order-upstream-1',
      partnerUserId: 'partner-user-1',
      partnerOrderNo: 'partner-order-1',
      upstreamApiKeyEncrypted: encrypt('api-key-1', encryptionKey),
      upstreamSecretKeyEncrypted: encrypt('secret-key-1', encryptionKey),
      productEndTime: null,
    };
    const prisma = {
      codingPlanProviderEntitlement: {
        findMany: jest.fn().mockResolvedValue([providerEntitlement]),
      },
    };
    const line = {
      id: 'line-1',
      adapterType: 'zhipu_partner',
    };
    const providerLines = {
      getForRuntime: jest.fn().mockResolvedValue(line),
    };
    const adapter = {
      queryCustomerUsage: jest.fn().mockResolvedValue({
        level: 'pro',
        quotaProgress: null,
        usageSummary: null,
        updatedAt: '2026-06-20T00:00:00.000Z',
      }),
    };
    const adapterRegistry = {
      get: jest.fn().mockReturnValue(adapter),
    };
    const config = {
      get: jest.fn((key: string) => key === 'ENCRYPTION_KEY' ? encryptionKey : undefined),
    };
    const service = new CodingPlanProviderUsageService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      providerLines as unknown as CodingPlanProviderLineService,
      adapterRegistry as unknown as CodingPlanProviderAdapterRegistry,
    );

    const result = await service.getUsageForEntitlements([{
      id: 'entitlement-1',
      providerEntitlementId: 'provider-entitlement-1',
      providerLineId: null,
      providerLineCode: null,
      fulfillmentMode: 'provider_resale',
      status: 'ACTIVE',
    }]);

    expect(adapter.queryCustomerUsage).toHaveBeenCalledWith(line, expect.objectContaining({
      upstreamApiKey: 'api-key-1',
      upstreamSecretKey: 'secret-key-1',
      upstreamProductId: 'upstream-1',
      upstreamOrderId: 'order-upstream-1',
    }));
    expect(result.get('entitlement-1')).toEqual(expect.objectContaining({
      status: 'available',
      level: 'pro',
      lastError: null,
    }));
  });
});
