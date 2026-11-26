import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { CodingPlanProviderLineService } from './coding-plan-provider-line.service';

describe('CodingPlanProviderLineService provider account identity', () => {
  function providerLine(overrides: Record<string, unknown> = {}) {
    return {
      id: 'line-kimi',
      code: 'kimi-main',
      name: 'Kimi Main',
      providerCode: 'kimi',
      providerAccountIdentityId: 'pai-kimi-main',
      providerName: 'Kimi',
      adapterType: 'kimi_partner',
      environment: 'production',
      apiBaseUrl: 'https://api.moonshot.cn',
      authType: 'partner_md5_header',
      partnerCodeEncrypted: null,
      partnerCodePrefix: null,
      partnerSecretEncrypted: null,
      partnerSecretPrefix: null,
      salesEnabled: true,
      fulfillmentEnabled: true,
      runtimeEnabled: true,
      syncEnabled: true,
      capabilities: null,
      qpsConfig: null,
      dedicatedEndpoints: [],
      metadata: null,
      createdAt: new Date('2026-08-11T00:00:00.000Z'),
      updatedAt: new Date('2026-08-11T00:00:00.000Z'),
      providerAccountIdentity: {
        ref: 'pa_kimi_main',
        providerCode: 'kimi',
        status: 'active',
      },
      ...overrides,
    };
  }

  function build(line = providerLine()) {
    const prisma = {
      codingPlanProviderLine: {
        findUnique: jest.fn().mockResolvedValue(line),
      },
    };
    const service = new CodingPlanProviderLineService(
      prisma as never,
      { get: jest.fn() } as unknown as ConfigService,
    );
    return { service, prisma };
  }

  it('returns the authoritative identity binding for fulfillment', async () => {
    const { service } = build();

    await expect(service.getForFulfillment('line-kimi')).resolves.toEqual(
      expect.objectContaining({
        providerCode: 'kimi',
        providerAccountIdentityId: 'pai-kimi-main',
      }),
    );
  });

  it('fails before fulfillment when the provider line has no identity binding', async () => {
    const { service } = build(providerLine({
      providerAccountIdentityId: null,
      providerAccountIdentity: null,
    }));

    await expect(service.getForFulfillment('line-kimi'))
      .rejects.toThrow(ServiceUnavailableException);
    await expect(service.getForFulfillment('line-kimi'))
      .rejects.toThrow('未配置供应商账户身份');
  });

  it('rejects an inactive or cross-provider identity before fulfillment', async () => {
    const { service } = build(providerLine({
      providerAccountIdentity: {
        ref: 'pa_openai_main',
        providerCode: 'openai',
        status: 'active',
      },
    }));

    await expect(service.getForFulfillment('line-kimi'))
      .rejects.toThrow('与供应商 kimi 不匹配');
  });
});
