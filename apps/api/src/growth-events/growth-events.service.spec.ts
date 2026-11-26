import { ConfigService } from '@nestjs/config';
import { GrowthEventsService } from './growth-events.service';
import { PrismaService } from '../prisma/prisma.service';

describe('GrowthEventsService', () => {
  let prisma: any;
  let configValues: Record<string, string>;
  let service: GrowthEventsService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    configValues = {};
    prisma = {
      growthEvent: {
        create: jest.fn(async ({ data }) => ({
          id: 'growth-1',
          ...data,
          createdAt: new Date('2026-07-22T00:00:00Z'),
          updatedAt: new Date('2026-07-22T00:00:00Z'),
          deliveryAttempts: 0,
          lastDeliveryAttemptAt: null,
          deliveredAt: null,
        })),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      apiKey: { findUnique: jest.fn() },
      order: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      gatewayBillingEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const config = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;
    service = new GrowthEventsService(prisma as PrismaService, config);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('records an internal sign-up fact but skips GA4 without consent', async () => {
    await service.recordSignUp({
      userId: 'user-1',
      analyticsConsent: false,
      analyticsClientId: '123.456',
      attribution: { utmSource: 'engineering-blog', utmCampaign: 'week-one' },
    });

    expect(prisma.growthEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: 'sign_up',
        dedupeKey: 'sign_up:user-1',
        analyticsConsent: false,
        deliveryStatus: 'SKIPPED',
        lastError: 'analytics_consent_not_granted',
        attribution: {
          utm_source: 'engineering-blog',
          utm_campaign: 'week-one',
        },
      }),
    });
  });

  it('resolves the API-key owner and records only a successful first API call', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({ userId: 'user-1' });
    prisma.growthEvent.findUnique.mockResolvedValue({
      analyticsConsent: true,
      analyticsClientId: '123.456',
      attribution: { utm_source: 'docs' },
    });

    await service.recordFirstApiCall({
      requestId: 'request-1',
      apiKeyId: 'key-1',
      modelName: 'model-a',
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      successful: true,
    });

    expect(prisma.growthEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: 'first_api_call',
        dedupeKey: 'first_api_call:user-1',
        userId: 'user-1',
        sourceEventId: 'request-1',
        deliveryStatus: 'PENDING',
        payload: expect.objectContaining({ model: 'model-a', total_tokens: 20 }),
      }),
    });
  });

  it('sends a consented event through GA4 Measurement Protocol without PII', async () => {
    configValues.GA4_MEASUREMENT_ID = 'G-TEST123';
    configValues.GA4_API_SECRET = 'test-secret';
    prisma.growthEvent.findMany.mockResolvedValue([
      {
        id: 'growth-1',
        eventName: 'purchase',
        userId: 'user-1',
        occurredAt: new Date('2026-07-22T00:00:00Z'),
        analyticsConsent: true,
        analyticsClientId: '123.456',
        payload: { transaction_id: 'order-1', value: 9.99, currency: 'USD' },
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 }) as any;

    const result = await service.deliverPending();

    expect(result).toEqual({ configured: true, scanned: 1, delivered: 1, failed: 0 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('measurement_id=G-TEST123');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      client_id: '123.456',
      user_id: 'user-1',
      consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
      events: [
        {
          name: 'purchase',
          params: {
            transaction_id: 'order-1',
            value: 9.99,
            currency: 'USD',
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/email|phone/i);
    expect(prisma.growthEvent.update).toHaveBeenCalledWith({
      where: { id: 'growth-1' },
      data: expect.objectContaining({ deliveryStatus: 'DELIVERED' }),
    });
  });
});
