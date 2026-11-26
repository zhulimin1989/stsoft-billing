import { ConfigService } from '@nestjs/config';
import { ZhipuPartnerAdapter } from './zhipu-partner.adapter';
import type { ProviderLineRuntimeConfig } from './coding-plan-provider.types';

describe('ZhipuPartnerAdapter', () => {
  const fetchMock = jest.fn();
  const line: ProviderLineRuntimeConfig = {
    id: 'line-1',
    code: 'zhipu_cn',
    name: 'Zhipu CN',
    providerCode: 'zhipu',
    providerAccountIdentityId: 'pai-zhipu-main',
    providerName: 'Zhipu',
    adapterType: 'zhipu_partner',
    environment: 'production',
    apiBaseUrl: 'https://bigmodel.cn',
    authType: 'partner_md5_header',
    partnerCode: 'TIANYIYUN',
    partnerSecretKey: 'secret',
    qpsConfig: null,
    capabilities: null,
    dedicatedEndpoints: [],
    metadata: null,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as typeof fetch;
    jest.spyOn(Date, 'now').mockReturnValue(1678888888000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates order from provider createOrder response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        code: 200,
        msg: '操作成功',
        data: {
          orderId: 'provider-order-1',
          apiKey: 'sk-created',
          secretKey: 'secret-created',
          productStartTime: '2026-06-16T00:00:00+08:00',
          productEndTime: '2026-09-16T00:00:00+08:00',
        },
      }),
    });

    const adapter = new ZhipuPartnerAdapter({
      get: jest.fn(),
    } as unknown as ConfigService);

    const result = await adapter.createOrder(line, {
      partnerUserId: 'ty_user_12345',
      partnerOrderNo: 'ORDER_20231027001',
      upstreamProductId: 'product-0d9e64',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [createUrl, createRequest] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(createUrl)).toBe('https://bigmodel.cn/api/biz/partner/createOrder');
    expect(createRequest.method).toBe('POST');
    expect(createRequest.body).toBe(JSON.stringify({
      partnerUserId: 'ty_user_12345',
      partnerOrderNo: 'ORDER_20231027001',
      productId: 'product-0d9e64',
    }));
    expect(result).toMatchObject({
      upstreamOrderId: 'provider-order-1',
      apiKey: 'sk-created',
      secretKey: 'secret-created',
      credentialFormat: 'apiKey.secretKey',
      productStartTime: '2026-06-16T00:00:00+08:00',
      productEndTime: '2026-09-16T00:00:00+08:00',
    });
  });

  it('propagates createOrder failure without fallback queries', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        code: 500,
        msg: '创建订单失败',
        data: null,
      }),
    });

    const adapter = new ZhipuPartnerAdapter({
      get: jest.fn(),
    } as unknown as ConfigService);

    await expect(adapter.createOrder(line, {
      partnerUserId: 'ty_user_12345',
      partnerOrderNo: 'ORDER_20231027001',
      upstreamProductId: 'product-0d9e64',
    })).rejects.toThrow('创建订单失败');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [createUrl] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(createUrl)).toBe('https://bigmodel.cn/api/biz/partner/createOrder');
  });

  it('queries customer usage by partnerUserId and parses quota progress', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        code: 200,
        msg: 'success',
        data: {
          level: 'pro',
          quotaProgress: {
            models: {
              fiveHour: { progressPercent: 62, resetAt: '2026-04-17T15:00:00+08:00' },
              weekly: { progressPercent: 48, resetAt: '2026-04-20T00:00:00+08:00' },
            },
            tools: {
              monthly: { progressPercent: 71, resetAt: '2026-05-01T00:00:00+08:00' },
            },
          },
          usageSummary: {
            day: {
              models: { total: 100, items: [{ modelCode: 'GLM-5.1', usage: 70 }] },
              tools: { total: 12, items: [{ toolCode: 'web-reader', toolName: '网页读取 MCP', usage: 12 }] },
            },
          },
          updatedAt: '2026-04-17T10:40:00+08:00',
        },
      }),
    });

    const adapter = new ZhipuPartnerAdapter({
      get: jest.fn(),
    } as unknown as ConfigService);

    const result = await adapter.queryCustomerUsage(line, {
      upstreamApiKey: 'should-not-be-sent',
      upstreamSecretKey: 'should-not-be-sent',
      upstreamProductId: 'product-1',
      upstreamOrderId: 'order-1',
      partnerUserId: 'ty_user_12345',
      partnerOrderNo: 'partner-order-1',
    });

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://bigmodel.cn/api/biz/partner/queryCustomerUsage?partnerUserId=ty_user_12345');
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Partner-Code': 'TIANYIYUN',
      'X-Timestamp': '1678888888000',
    });
    expect(request.headers).not.toHaveProperty('Authorization');
    expect(result.level).toBe('pro');
    expect(result.quotaProgress?.models?.fiveHour?.progressPercent).toBe(62);
    expect(result.quotaProgress?.models?.weekly?.progressPercent).toBe(48);
    expect(result.quotaProgress?.tools?.monthly?.progressPercent).toBe(71);
    expect(result.usageSummary?.day?.models?.total).toBe(100);
    expect(result.usageSummary?.day?.tools?.items[0]?.toolName).toBe('网页读取 MCP');
    expect(result.updatedAt).toBe('2026-04-17T10:40:00+08:00');
  });

  it('keeps customer usage queries on the documented GET contract', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ code: 200, msg: 'success', data: {} }),
    });

    const adapter = new ZhipuPartnerAdapter({
      get: jest.fn(),
    } as unknown as ConfigService);

    await adapter.queryCustomerUsage({
      ...line,
      capabilities: {
        usageQuery: {
          method: 'POST',
          includeFields: ['partnerUserId', 'apiKey', 'secretKey', 'orderId', 'partnerOrderNo'],
          fields: { partnerUserId: 'customerId' },
        },
      },
    }, {
      upstreamApiKey: 'api-key-must-not-be-sent',
      upstreamSecretKey: 'secret-must-not-be-sent',
      upstreamProductId: 'product-1',
      upstreamOrderId: 'order-1',
      partnerUserId: 'ty_user_12345',
      partnerOrderNo: 'partner-order-1',
    });

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://bigmodel.cn/api/biz/partner/queryCustomerUsage?partnerUserId=ty_user_12345');
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    expect(request.headers).not.toHaveProperty('Authorization');
  });
});
