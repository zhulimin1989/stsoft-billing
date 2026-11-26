/**
 * P2-A3 §8.1 / §8.3 测试:用量阈值检查 + 24h 去重 + 跨日重置 + 主链路 swallow。
 *
 * 关注:
 *  - DAILY_TOKEN 超阈值 → createAlert(category=USAGE, severity=MEDIUM, sourceId 含日期桶)
 *  - DAILY_TOKEN 未超阈值 → 不调 createAlert
 *  - HOURLY_CALL 超阈值 → createAlert(severity=HIGH, sourceId 含小时桶)
 *  - 同日重复触发 → 24h 去重靠 createAlert 内部的 5min 软窗口 + 同 sourceId 命中
 *    (这里 createAlert 是 mock,我们只验"我们传给 createAlert 的 sourceId 在同
 *     一日是稳定的",从而保证 5min 窗口能去重)
 *  - 跨日(date bucket 变)→ sourceId 不同,新发一条
 *  - prisma 抛错 → 全部 swallow,不抛出
 */
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AlertEventService } from './alert-events.service';
import { UsageThresholdService } from './usage-threshold.service';

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    creditTransaction: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { totalTokens: 0 } }),
      count: jest.fn().mockResolvedValue(0),
      ...overrides,
    },
  };
}

function makeAlertEvents() {
  return {
    createAlert: jest.fn().mockResolvedValue({ id: 'a' }),
  };
}

function makeConfig(overrides: Record<string, string> = {}) {
  const map: Record<string, string> = {
    USAGE_DAILY_TOKEN_THRESHOLD: '',
    USAGE_HOURLY_CALL_THRESHOLD: '',
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => map[key]),
  };
}

async function build(
  prismaOverrides: Record<string, unknown> = {},
  configOverrides: Record<string, string> = {},
) {
  const prisma = makePrisma(prismaOverrides);
  const alertEvents = makeAlertEvents();
  const config = makeConfig(configOverrides);
  const m = await Test.createTestingModule({
    providers: [
      UsageThresholdService,
      { provide: PrismaService, useValue: prisma },
      { provide: AlertEventService, useValue: alertEvents },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return {
    service: m.get(UsageThresholdService),
    prisma,
    alertEvents,
    config,
  };
}

describe('UsageThresholdService.check', () => {
  it('noops on empty userId', async () => {
    const { service, prisma, alertEvents } = await build();
    await service.check('');
    expect(prisma.creditTransaction.aggregate).not.toHaveBeenCalled();
    expect(prisma.creditTransaction.count).not.toHaveBeenCalled();
    expect(alertEvents.createAlert).not.toHaveBeenCalled();
  });

  it('does not alert when both metrics are below threshold', async () => {
    const { service, alertEvents } = await build({
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { totalTokens: 100 } }),
      count: jest.fn().mockResolvedValue(10),
    });
    await service.check('u1');
    expect(alertEvents.createAlert).not.toHaveBeenCalled();
  });

  describe('DAILY_TOKEN', () => {
    it('fires MEDIUM USAGE alert with date-bucketed sourceId when over threshold', async () => {
      const { service, alertEvents } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: 1_500_000 } }),
        // hourly count below threshold
        count: jest.fn().mockResolvedValue(0),
      });
      await service.check('u1');
      const dailyCalls = alertEvents.createAlert.mock.calls.filter(
        (c: any[]) => c[0].context?.metric === 'DAILY_TOKEN',
      );
      expect(dailyCalls).toHaveLength(1);
      const arg = dailyCalls[0][0];
      expect(arg.category).toBe('USAGE');
      expect(arg.severity).toBe('MEDIUM');
      expect(arg.userId).toBe('u1');
      expect(arg.sourceType).toBe('user_usage');
      expect(arg.sourceId).toMatch(
        /^u1:daily_token:\d{4}-\d{2}-\d{2}$/,
      );
      expect(arg.context.value).toBe(1_500_000);
      expect(arg.context.threshold).toBe(1_000_000);
    });

    it('uses USAGE_DAILY_TOKEN_THRESHOLD env override when set', async () => {
      const { service, alertEvents } = await build(
        {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _sum: { totalTokens: 600 } }),
          count: jest.fn().mockResolvedValue(0),
        },
        { USAGE_DAILY_TOKEN_THRESHOLD: '500' },
      );
      await service.check('u1');
      const calls = alertEvents.createAlert.mock.calls.filter(
        (c: any[]) => c[0].context?.metric === 'DAILY_TOKEN',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0].context.threshold).toBe(500);
    });

    it('reuses same sourceId across same-day repeat triggers (5min dedup will collapse)', async () => {
      const { service, alertEvents } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: 1_500_000 } }),
        count: jest.fn().mockResolvedValue(0),
      });
      await service.check('u1');
      await service.check('u1');
      const calls = alertEvents.createAlert.mock.calls.filter(
        (c: any[]) => c[0].context?.metric === 'DAILY_TOKEN',
      );
      // We invoked createAlert twice at this layer (mock), but both with the
      // SAME sourceId — that's how the real 5min dedup in createAlert collapses
      // them into a single alert row in production.
      expect(calls).toHaveLength(2);
      expect(calls[0][0].sourceId).toBe(calls[1][0].sourceId);
    });

    it('changes sourceId across day rollover (new bucket fires fresh)', async () => {
      jest.useFakeTimers();
      const { service, alertEvents } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: 1_500_000 } }),
        count: jest.fn().mockResolvedValue(0),
      });

      // UTC-anchored times: service buckets by UTC, so test must too,
      // 否则在 UTC+8 本地会把 23:30 当作 UTC 15:30(同一天)而看不到跨日。
      jest.setSystemTime(new Date('2026-04-30T23:30:00Z'));
      await service.check('u1');
      jest.setSystemTime(new Date('2026-05-01T00:30:00Z'));
      await service.check('u1');

      const calls = alertEvents.createAlert.mock.calls.filter(
        (c: any[]) => c[0].context?.metric === 'DAILY_TOKEN',
      );
      expect(calls).toHaveLength(2);
      expect(calls[0][0].sourceId).not.toBe(calls[1][0].sourceId);
      jest.useRealTimers();
    });

    it('handles null aggregate sum (no usage today)', async () => {
      const { service, alertEvents } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: null } }),
        count: jest.fn().mockResolvedValue(0),
      });
      await service.check('u1');
      expect(alertEvents.createAlert).not.toHaveBeenCalled();
    });

    it('swallows prisma errors (must not break deduct return path)', async () => {
      const { service, alertEvents } = await build({
        aggregate: jest.fn().mockRejectedValue(new Error('pg down')),
        count: jest.fn().mockResolvedValue(0),
      });
      await expect(service.check('u1')).resolves.toBeUndefined();
      // hourly path still ran (count was called) but no alert because count == 0
      expect(alertEvents.createAlert).not.toHaveBeenCalled();
    });

    it('swallows alert write errors silently', async () => {
      const { service, alertEvents } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: 1_500_000 } }),
        count: jest.fn().mockResolvedValue(0),
      });
      alertEvents.createAlert.mockRejectedValueOnce(new Error('alert dead'));
      await expect(service.check('u1')).resolves.toBeUndefined();
    });
  });

  describe('HOURLY_CALL', () => {
    it('fires HIGH USAGE alert with hour-bucketed sourceId when over threshold', async () => {
      const { service, alertEvents } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: 0 } }),
        count: jest.fn().mockResolvedValue(2000),
      });
      await service.check('u1');
      const hourlyCalls = alertEvents.createAlert.mock.calls.filter(
        (c: any[]) => c[0].context?.metric === 'HOURLY_CALL',
      );
      expect(hourlyCalls).toHaveLength(1);
      const arg = hourlyCalls[0][0];
      expect(arg.severity).toBe('HIGH');
      expect(arg.sourceId).toMatch(
        /^u1:hourly_call:\d{4}-\d{2}-\d{2}-\d{2}$/,
      );
      expect(arg.context.value).toBe(2000);
      expect(arg.context.threshold).toBe(1000);
    });

    it('counts only CONSUME-type transactions', async () => {
      const countMock = jest.fn().mockResolvedValue(1500);
      const { service } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: 0 } }),
        count: countMock,
      });
      await service.check('u1');
      const where = countMock.mock.calls[0][0].where;
      expect(where.userId).toBe('u1');
      expect(where.type).toBe('CONSUME');
      expect(where.createdAt.gte).toBeInstanceOf(Date);
    });

    it('uses USAGE_HOURLY_CALL_THRESHOLD env override when set', async () => {
      const { service, alertEvents } = await build(
        {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _sum: { totalTokens: 0 } }),
          count: jest.fn().mockResolvedValue(20),
        },
        { USAGE_HOURLY_CALL_THRESHOLD: '10' },
      );
      await service.check('u1');
      const calls = alertEvents.createAlert.mock.calls.filter(
        (c: any[]) => c[0].context?.metric === 'HOURLY_CALL',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0].context.threshold).toBe(10);
    });

    it('changes sourceId across hour rollover', async () => {
      jest.useFakeTimers();
      const { service, alertEvents } = await build({
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTokens: 0 } }),
        count: jest.fn().mockResolvedValue(2000),
      });

      // UTC-anchored: 跨整点桶要在 UTC 上跨,本地时区无关。
      jest.setSystemTime(new Date('2026-04-30T10:30:00Z'));
      await service.check('u1');
      jest.setSystemTime(new Date('2026-04-30T11:30:00Z'));
      await service.check('u1');

      const calls = alertEvents.createAlert.mock.calls.filter(
        (c: any[]) => c[0].context?.metric === 'HOURLY_CALL',
      );
      expect(calls).toHaveLength(2);
      expect(calls[0][0].sourceId).not.toBe(calls[1][0].sourceId);
      jest.useRealTimers();
    });
  });

  describe('threshold parse fallback', () => {
    it('falls back to defaults on garbage env values', async () => {
      const { service, alertEvents } = await build(
        {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _sum: { totalTokens: 1_500_000 } }),
          count: jest.fn().mockResolvedValue(2000),
        },
        {
          USAGE_DAILY_TOKEN_THRESHOLD: 'not-a-number',
          USAGE_HOURLY_CALL_THRESHOLD: '-5',
        },
      );
      await service.check('u1');
      const dailyCall = alertEvents.createAlert.mock.calls.find(
        (c: any[]) => c[0].context?.metric === 'DAILY_TOKEN',
      );
      const hourlyCall = alertEvents.createAlert.mock.calls.find(
        (c: any[]) => c[0].context?.metric === 'HOURLY_CALL',
      );
      expect(dailyCall[0].context.threshold).toBe(1_000_000);
      expect(hourlyCall[0].context.threshold).toBe(1000);
    });
  });
});
