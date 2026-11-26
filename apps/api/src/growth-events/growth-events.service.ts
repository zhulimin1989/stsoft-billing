import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrowthEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const GROWTH_EVENT_NAMES = [
  'sign_up',
  'first_api_call',
  'purchase',
  'refund',
] as const;

export type GrowthEventName = (typeof GROWTH_EVENT_NAMES)[number];

type JsonRecord = Record<string, string | number | boolean | null>;

export interface SignUpGrowthEventInput {
  userId: string;
  source?: string;
  analyticsConsent?: boolean | null;
  analyticsClientId?: string | null;
  attribution?: {
    referralCode?: string | null;
    deviceId?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmContent?: string | null;
    utmTerm?: string | null;
    landingUrl?: string | null;
    capturedAt?: string | Date | null;
    referrer?: string | null;
  };
}

export interface FirstApiCallGrowthEventInput {
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  modelName?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  occurredAt?: Date | null;
  successful: boolean;
}

interface RecordGrowthEventInput {
  eventName: GrowthEventName;
  dedupeKey: string;
  userId: string;
  source: string;
  sourceEventId?: string | null;
  occurredAt: Date;
  analyticsConsent: boolean;
  analyticsClientId?: string | null;
  attribution?: Prisma.InputJsonValue;
  payload: Prisma.InputJsonValue;
}

@Injectable()
export class GrowthEventsService {
  private readonly logger = new Logger(GrowthEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async recordSignUp(input: SignUpGrowthEventInput): Promise<GrowthEvent | null> {
    const userId = input.userId.trim();
    if (!userId) return null;
    const analyticsClientId = this.normalizeAnalyticsClientId(input.analyticsClientId);
    const analyticsConsent = input.analyticsConsent === true;
    const attribution = this.compactAttribution(input.attribution);
    return this.record({
      eventName: 'sign_up',
      dedupeKey: `sign_up:${userId}`,
      userId,
      source: input.source?.trim() || 'user_api',
      occurredAt: new Date(),
      analyticsConsent,
      analyticsClientId,
      ...(Object.keys(attribution).length > 0
        ? { attribution: attribution as Prisma.InputJsonValue }
        : {}),
      payload: { method: 'account_registration' },
    });
  }

  async recordFirstApiCall(
    input: FirstApiCallGrowthEventInput,
  ): Promise<GrowthEvent | null> {
    if (!input.successful) return null;
    const userId = await this.resolveUserId(input.userId, input.apiKeyId);
    if (!userId) {
      this.logger.warn(`first_api_call skipped because user could not be resolved requestId=${input.requestId}`);
      return null;
    }
    const profile = await this.analyticsProfile(userId);
    return this.record({
      eventName: 'first_api_call',
      dedupeKey: `first_api_call:${userId}`,
      userId,
      source: 'gateway_usage',
      sourceEventId: input.requestId,
      occurredAt: input.occurredAt ?? new Date(),
      analyticsConsent: profile.analyticsConsent,
      analyticsClientId: profile.analyticsClientId,
      attribution: profile.attribution,
      payload: this.cleanPayload({
        request_id: input.requestId,
        model: input.modelName,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        total_tokens: input.totalTokens,
      }),
    });
  }

  async recordPurchase(orderId: string): Promise<GrowthEvent | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        orderType: true,
        amountCents: true,
        currency: true,
        completedAt: true,
      },
    });
    if (!order?.completedAt || order.amountCents <= 0) return null;
    const profile = await this.analyticsProfile(order.userId);
    return this.record({
      eventName: 'purchase',
      dedupeKey: `purchase:${order.id}`,
      userId: order.userId,
      source: 'billing_order',
      sourceEventId: order.id,
      occurredAt: order.completedAt,
      analyticsConsent: profile.analyticsConsent,
      analyticsClientId: profile.analyticsClientId,
      attribution: profile.attribution,
      payload: {
        transaction_id: order.id,
        value: order.amountCents / 100,
        currency: order.currency.toUpperCase(),
        order_type: order.orderType,
      },
    });
  }

  async recordRefund(orderId: string): Promise<GrowthEvent | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        orderType: true,
        amountCents: true,
        refundAmountCents: true,
        currency: true,
        refundedAt: true,
      },
    });
    if (!order?.refundedAt) return null;
    const profile = await this.analyticsProfile(order.userId);
    return this.record({
      eventName: 'refund',
      dedupeKey: `refund:${order.id}`,
      userId: order.userId,
      source: 'billing_order',
      sourceEventId: order.id,
      occurredAt: order.refundedAt,
      analyticsConsent: profile.analyticsConsent,
      analyticsClientId: profile.analyticsClientId,
      attribution: profile.attribution,
      payload: {
        transaction_id: order.id,
        value: (order.refundAmountCents ?? order.amountCents) / 100,
        currency: order.currency.toUpperCase(),
        order_type: order.orderType,
      },
    });
  }

  async reconcileRecentFacts(): Promise<{
    usageScanned: number;
    ordersScanned: number;
  }> {
    const lookbackHours = this.positiveInt('GROWTH_EVENTS_RECONCILE_HOURS', 48);
    const batchSize = Math.min(this.positiveInt('GROWTH_EVENTS_RECONCILE_BATCH', 500), 1000);
    const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const usageEvents = await this.prisma.gatewayBillingEvent.findMany({
      where: { status: 'DEDUCTED', processedAt: { gte: since } },
      orderBy: { occurredAt: 'asc' },
      take: batchSize,
      select: {
        requestId: true,
        userId: true,
        apiKeyId: true,
        modelName: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        occurredAt: true,
        rawEvent: true,
      },
    });
    for (const event of usageEvents) {
      const raw = this.jsonObject(event.rawEvent);
      await this.recordFirstApiCall({
        requestId: event.requestId,
        userId: event.userId,
        apiKeyId: event.apiKeyId,
        modelName: event.modelName,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        occurredAt: event.occurredAt,
        successful: raw.status === 'success',
      });
    }

    const orders = await this.prisma.order.findMany({
      where: {
        OR: [
          { completedAt: { gte: since } },
          { refundedAt: { gte: since } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { id: true, completedAt: true, refundedAt: true },
    });
    for (const order of orders) {
      if (order.completedAt) await this.recordPurchase(order.id);
      if (order.refundedAt) await this.recordRefund(order.id);
    }
    return { usageScanned: usageEvents.length, ordersScanned: orders.length };
  }

  async deliverPending(limit = 25): Promise<{
    configured: boolean;
    scanned: number;
    delivered: number;
    failed: number;
  }> {
    const measurementId = this.config.get<string>('GA4_MEASUREMENT_ID')?.trim();
    const apiSecret = this.config.get<string>('GA4_API_SECRET')?.trim();
    if (!measurementId || !/^G-[A-Z0-9]+$/i.test(measurementId) || !apiSecret) {
      return { configured: false, scanned: 0, delivered: 0, failed: 0 };
    }
    const maxAttempts = this.positiveInt('GA4_DELIVERY_MAX_ATTEMPTS', 10);
    const events = await this.prisma.growthEvent.findMany({
      where: {
        deliveryStatus: { in: ['PENDING', 'FAILED'] },
        deliveryAttempts: { lt: maxAttempts },
        analyticsConsent: true,
        analyticsClientId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 25),
    });

    let delivered = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.deliverEvent(event, measurementId, apiSecret);
        delivered += 1;
      } catch (err) {
        failed += 1;
        await this.markDeliveryFailure(event.id, err);
      }
    }
    return { configured: true, scanned: events.length, delivered, failed };
  }

  async summary(hours = 168) {
    const since = new Date(Date.now() - Math.min(Math.max(hours, 1), 24 * 90) * 3600_000);
    const [byEvent, byDelivery, recent] = await Promise.all([
      this.prisma.growthEvent.groupBy({
        by: ['eventName'],
        where: { occurredAt: { gte: since } },
        _count: { _all: true },
        orderBy: { eventName: 'asc' },
      }),
      this.prisma.growthEvent.groupBy({
        by: ['deliveryStatus'],
        where: { occurredAt: { gte: since } },
        _count: { _all: true },
        orderBy: { deliveryStatus: 'asc' },
      }),
      this.prisma.growthEvent.findMany({
        where: { occurredAt: { gte: since } },
        orderBy: { occurredAt: 'desc' },
        take: 20,
        select: {
          id: true,
          eventName: true,
          source: true,
          sourceEventId: true,
          occurredAt: true,
          analyticsConsent: true,
          deliveryStatus: true,
          deliveryAttempts: true,
          lastError: true,
        },
      }),
    ]);
    return { since, byEvent, byDelivery, recent };
  }

  private async record(input: RecordGrowthEventInput): Promise<GrowthEvent | null> {
    const eligible = input.analyticsConsent && Boolean(input.analyticsClientId);
    try {
      return await this.prisma.growthEvent.create({
        data: {
          eventName: input.eventName,
          dedupeKey: input.dedupeKey,
          userId: input.userId,
          source: input.source,
          sourceEventId: input.sourceEventId ?? null,
          occurredAt: input.occurredAt,
          analyticsConsent: input.analyticsConsent,
          analyticsClientId: input.analyticsClientId ?? null,
          ...(input.attribution ? { attribution: input.attribution } : {}),
          payload: input.payload,
          deliveryStatus: eligible ? 'PENDING' : 'SKIPPED',
          lastError: eligible
            ? null
            : input.analyticsConsent
              ? 'analytics_client_id_missing'
              : 'analytics_consent_not_granted',
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.growthEvent.findUnique({ where: { dedupeKey: input.dedupeKey } });
      }
      this.logger.error(
        `growth event record failed name=${input.eventName} sourceEventId=${input.sourceEventId ?? '-'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async analyticsProfile(userId: string): Promise<{
    analyticsConsent: boolean;
    analyticsClientId: string | null;
    attribution?: Prisma.InputJsonValue;
  }> {
    const signUp = await this.prisma.growthEvent.findUnique({
      where: { dedupeKey: `sign_up:${userId}` },
      select: {
        analyticsConsent: true,
        analyticsClientId: true,
        attribution: true,
      },
    });
    return {
      analyticsConsent: signUp?.analyticsConsent === true,
      analyticsClientId: this.normalizeAnalyticsClientId(signUp?.analyticsClientId) ?? null,
      ...(signUp?.attribution
        ? { attribution: signUp.attribution as Prisma.InputJsonValue }
        : {}),
    };
  }

  private async resolveUserId(
    userId?: string | null,
    apiKeyId?: string | null,
  ): Promise<string | null> {
    const direct = userId?.trim();
    if (direct) return direct;
    const keyId = apiKeyId?.trim();
    if (!keyId) return null;
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      select: { userId: true },
    });
    return apiKey?.userId ?? null;
  }

  private async deliverEvent(
    event: GrowthEvent,
    measurementId: string,
    apiSecret: string,
  ): Promise<void> {
    const endpoint = new URL('https://region1.google-analytics.com/mp/collect');
    endpoint.searchParams.set('measurement_id', measurementId);
    endpoint.searchParams.set('api_secret', apiSecret);
    const payload = this.jsonObject(event.payload);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: event.analyticsClientId,
        user_id: event.userId,
        timestamp_micros: event.occurredAt.getTime() * 1000,
        consent: {
          ad_user_data: 'DENIED',
          ad_personalization: 'DENIED',
        },
        events: [
          {
            name: event.eventName,
            params: {
              ...payload,
              engagement_time_msec: 1,
            },
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`GA4 Measurement Protocol returned HTTP ${response.status}`);
    }
    await this.prisma.growthEvent.update({
      where: { id: event.id },
      data: {
        deliveryStatus: 'DELIVERED',
        deliveryAttempts: { increment: 1 },
        lastDeliveryAttemptAt: new Date(),
        deliveredAt: new Date(),
        lastError: null,
      },
    });
  }

  private async markDeliveryFailure(eventId: string, err: unknown): Promise<void> {
    await this.prisma.growthEvent.update({
      where: { id: eventId },
      data: {
        deliveryStatus: 'FAILED',
        deliveryAttempts: { increment: 1 },
        lastDeliveryAttemptAt: new Date(),
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
    });
  }

  private compactAttribution(
    input: SignUpGrowthEventInput['attribution'],
  ): JsonRecord {
    if (!input) return {};
    const output: JsonRecord = {};
    const entries: Array<[string, unknown, number]> = [
      ['referral_code', input.referralCode, 64],
      ['device_id', input.deviceId, 128],
      ['utm_source', input.utmSource, 100],
      ['utm_medium', input.utmMedium, 100],
      ['utm_campaign', input.utmCampaign, 100],
      ['utm_content', input.utmContent, 100],
      ['utm_term', input.utmTerm, 100],
      ['landing_url', input.landingUrl, 2048],
      ['captured_at', input.capturedAt instanceof Date ? input.capturedAt.toISOString() : input.capturedAt, 64],
      ['referrer', input.referrer, 2048],
    ];
    for (const [key, raw, maxLength] of entries) {
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (value) output[key] = value.slice(0, maxLength);
    }
    return output;
  }

  private cleanPayload(input: Record<string, unknown>): Prisma.InputJsonValue {
    const output: Record<string, string | number> = {};
    for (const [key, raw] of Object.entries(input)) {
      if (typeof raw === 'string') {
        const value = raw.trim();
        if (value) output[key] = value.slice(0, 100);
      } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        output[key] = raw;
      }
    }
    return output as Prisma.InputJsonValue;
  }

  private normalizeAnalyticsClientId(value?: string | null): string | null {
    const normalized = value?.trim();
    return normalized && /^\d+\.\d+$/.test(normalized) ? normalized : null;
  }

  private jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private positiveInt(key: string, fallback: number): number {
    const parsed = Number.parseInt(this.config.get<string>(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
