import { Test } from '@nestjs/testing';
import { AlertEventService } from '../alert-events/alert-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  RISK_BLOCKED_CACHE_PREFIX,
  RISK_BLOCKED_CACHE_TTL_SECONDS,
  RiskEngineService,
} from './risk-engine.service';
import { RiskFlagsService } from './risk-flags.service';

describe('RiskEngineService', () => {
  let engine: RiskEngineService;
  let prisma: any;
  let flags: any;

  const rule = (overrides: Record<string, unknown> = {}) => ({
    id: 'rule1',
    name: 'rule',
    ruleType: 'USAGE_THRESHOLD',
    config: JSON.stringify({
      metric: 'DAILY_TOKEN',
      threshold: 1000,
      windowSec: 86400,
    }),
    action: 'ALERT',
    isActive: true,
    triggerCount: 0,
    lastTriggeredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      riskRule: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      riskList: {
        findFirst: jest.fn(),
      },
      riskFlag: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      apiKey: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      user: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      order: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    flags = {
      createFlag: jest.fn().mockResolvedValue({ id: 'flag1' }),
    };
    const m = await Test.createTestingModule({
      providers: [
        RiskEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: RiskFlagsService, useValue: flags },
      ],
    }).compile();
    engine = m.get(RiskEngineService);
  });

  // ------------ isUserBlocked ------------

  it('isUserBlocked: no rules → not blocked', async () => {
    prisma.riskRule.findMany.mockResolvedValueOnce([]);
    const r = await engine.isUserBlocked({ userId: 'u1', email: 'a@b.com' });
    expect(r.blocked).toBe(false);
    expect(r.matchedRuleId).toBeNull();
  });

  it('isUserBlocked: BLOCK action → blocked=true on match', async () => {
    prisma.riskRule.findMany.mockResolvedValueOnce([
      rule({
        ruleType: 'BLACKLIST',
        action: 'BLOCK',
        config: JSON.stringify({ matchTypes: ['EMAIL'] }),
      }),
    ]);
    prisma.riskList.findFirst.mockResolvedValueOnce({
      id: 'list1',
      listType: 'EMAIL',
      value: 'a@b.com',
      reason: 'spam',
    });
    const r = await engine.isUserBlocked({ email: 'a@b.com' });
    expect(r.blocked).toBe(true);
    expect(r.matchedRuleId).toBe('rule1');
    expect(r.action).toBe('BLOCK');
  });

  it('isUserBlocked: ALERT action → blocked=false but match recorded', async () => {
    prisma.riskRule.findMany.mockResolvedValueOnce([
      rule({
        ruleType: 'BLACKLIST',
        action: 'ALERT',
        config: JSON.stringify({ matchTypes: ['IP'] }),
      }),
    ]);
    prisma.riskList.findFirst.mockResolvedValueOnce({
      id: 'list1',
      listType: 'IP',
      value: '1.2.3.4',
      reason: 'tor',
    });
    const r = await engine.isUserBlocked({ ip: '1.2.3.4' });
    expect(r.blocked).toBe(false);
    expect(r.matchedListType).toBe('IP');
  });

  it('isUserBlocked: returns "no signals" when nothing supplied', async () => {
    prisma.riskRule.findMany.mockResolvedValueOnce([
      rule({
        ruleType: 'BLACKLIST',
        action: 'BLOCK',
        config: JSON.stringify({ matchTypes: ['EMAIL'] }),
      }),
    ]);
    const r = await engine.isUserBlocked({});
    expect(r.blocked).toBe(false);
    expect(r.reason).toMatch(/no signals/);
  });

  // ------------ isUserBlockedCached (spec §8.3) ------------

  describe('isUserBlockedCached', () => {
    let redis: { get: jest.Mock; set: jest.Mock };
    let cachedEngine: RiskEngineService;

    beforeEach(async () => {
      redis = { get: jest.fn(), set: jest.fn().mockResolvedValue('OK') };
      const m = await Test.createTestingModule({
        providers: [
          RiskEngineService,
          { provide: PrismaService, useValue: prisma },
          { provide: RiskFlagsService, useValue: flags },
          { provide: RedisService, useValue: redis },
        ],
      }).compile();
      cachedEngine = m.get(RiskEngineService);
    });

    it('cache hit (JSON blocked envelope) → blocked=true with metadata, no DB', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          b: 1,
          r: 'rule-cache-1',
          t: 'EMAIL',
          v: 'cached@example.com',
          x: 'spam',
        }),
      );
      const r = await cachedEngine.isUserBlockedCached({
        userId: 'u-123',
        ip: '1.2.3.4',
      });
      expect(r.blocked).toBe(true);
      expect(r.matchedRuleId).toBe('rule-cache-1');
      expect(r.matchedListType).toBe('EMAIL');
      expect(r.matchedValue).toBe('cached@example.com');
      expect(r.reason).toBe('spam');
      expect(redis.get).toHaveBeenCalledWith(`${RISK_BLOCKED_CACHE_PREFIX}u-123`);
      expect(prisma.riskRule.findMany).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('cache miss → calls DB, then SET JSON envelope with TTL=60s', async () => {
      redis.get.mockResolvedValueOnce(null);
      // No active BLACKLIST rules → not blocked.
      prisma.riskRule.findMany.mockResolvedValueOnce([]);

      const r = await cachedEngine.isUserBlockedCached({
        userId: 'u-456',
        ip: '5.6.7.8',
      });
      expect(r.blocked).toBe(false);
      expect(prisma.riskRule.findMany).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        `${RISK_BLOCKED_CACHE_PREFIX}u-456`,
        JSON.stringify({ b: 0 }),
        'EX',
        RISK_BLOCKED_CACHE_TTL_SECONDS,
      );
    });

    it('cache miss + match → DB returns blocked, cached as JSON envelope', async () => {
      redis.get.mockResolvedValueOnce(null);
      prisma.riskRule.findMany.mockResolvedValueOnce([
        rule({
          ruleType: 'BLACKLIST',
          action: 'BLOCK',
          config: JSON.stringify({ matchTypes: ['USER_ID'] }),
        }),
      ]);
      prisma.riskList.findFirst.mockResolvedValueOnce({
        id: 'list1',
        listType: 'USER_ID',
        value: 'u-789',
        reason: 'fraud',
      });

      const r = await cachedEngine.isUserBlockedCached({ userId: 'u-789' });
      expect(r.blocked).toBe(true);
      // The SET payload must carry matched metadata so the next cache hit
      // can replay it for audit logging without a DB round-trip.
      const setCall = redis.set.mock.calls[0];
      expect(setCall[0]).toBe(`${RISK_BLOCKED_CACHE_PREFIX}u-789`);
      const envelope = JSON.parse(setCall[1] as string);
      expect(envelope).toMatchObject({
        b: 1,
        r: 'rule1',
        t: 'USER_ID',
        v: 'u-789',
      });
      expect(setCall[2]).toBe('EX');
      expect(setCall[3]).toBe(RISK_BLOCKED_CACHE_TTL_SECONDS);
    });

    it('dirty cache value → warn + fall through to DB (legacy "1"/"0" tolerated)', async () => {
      const warnSpy = jest
        .spyOn((cachedEngine as any).logger, 'warn')
        .mockImplementation(() => undefined);
      // Legacy pre-PR0-3 cache value or garbage from external flushdb.
      redis.get.mockResolvedValueOnce('1');
      prisma.riskRule.findMany.mockResolvedValueOnce([]); // DB says not blocked

      const r = await cachedEngine.isUserBlockedCached({
        userId: 'u-legacy',
      });

      // We MUST trust the DB, not the dirty cache value, even when "1"
      // looks blocky.
      expect(r.blocked).toBe(false);
      expect(prisma.riskRule.findMany).toHaveBeenCalledTimes(1);
      // Dirty value warning fired with key + value context.
      const dirtyCall = warnSpy.mock.calls.find(
        (c) =>
          typeof c[1] === 'string' &&
          c[1].includes('unexpected risk cache value'),
      );
      expect(dirtyCall).toBeDefined();
      expect(dirtyCall?.[0]).toMatchObject({
        key: `${RISK_BLOCKED_CACHE_PREFIX}u-legacy`,
        value: '1',
      });
      // And the cache is rewritten in JSON form.
      expect(redis.set).toHaveBeenCalledWith(
        `${RISK_BLOCKED_CACHE_PREFIX}u-legacy`,
        JSON.stringify({ b: 0 }),
        'EX',
        RISK_BLOCKED_CACHE_TTL_SECONDS,
      );
      warnSpy.mockRestore();
    });

    it('Redis GET failure → degrades to DB call (does not throw)', async () => {
      redis.get.mockRejectedValueOnce(new Error('redis down'));
      prisma.riskRule.findMany.mockResolvedValueOnce([]);

      const r = await cachedEngine.isUserBlockedCached({ userId: 'u-999' });
      expect(r.blocked).toBe(false);
      expect(prisma.riskRule.findMany).toHaveBeenCalled();
    });

    it('no userId → bypasses cache and goes straight to DB', async () => {
      prisma.riskRule.findMany.mockResolvedValueOnce([]);
      const r = await cachedEngine.isUserBlockedCached({
        ip: '1.1.1.1',
        email: 'x@y.com',
      });
      expect(r.blocked).toBe(false);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  // ------------ scanAll / scanRule ------------

  it('scanAll: skips rules of types it does not handle', async () => {
    prisma.riskRule.findMany.mockResolvedValueOnce([]);
    const result = await engine.scanAll();
    expect(result.rulesScanned).toBe(0);
  });

  it('scanRule USAGE_THRESHOLD: creates flags for over-threshold users', async () => {
    const r = rule();
    prisma.$queryRaw.mockResolvedValueOnce([
      { user_id: 'u1', total: 5000 },
      { user_id: 'u2', total: 2000 },
    ]);
    const result = await engine.scanRule(r as any);
    expect(result.matched).toBe(2);
    expect(flags.createFlag).toHaveBeenCalledTimes(2);
    expect(prisma.riskRule.update).toHaveBeenCalledWith({
      where: { id: 'rule1' },
      data: expect.objectContaining({
        triggerCount: { increment: 2 },
      }),
    });
  });

  it('scanRule IP_LIMIT: creates flags for users on each over-threshold IP', async () => {
    const r = rule({
      ruleType: 'IP_LIMIT',
      config: JSON.stringify({ windowDays: 7, maxAccountsPerIp: 3 }),
    });
    prisma.$queryRaw.mockResolvedValueOnce([
      { client_ip: '1.2.3.4', user_count: 5 },
    ]);
    prisma.order.findMany.mockResolvedValueOnce([
      { userId: 'u1' },
      { userId: 'u2' },
      { userId: 'u3' },
    ]);
    const result = await engine.scanRule(r as any);
    expect(result.matched).toBe(3);
    expect(flags.createFlag).toHaveBeenCalledTimes(3);
  });

  it('scanRule REFUND_RATE / GLOBAL: bumps triggerCount but creates no flag', async () => {
    const r = rule({
      ruleType: 'REFUND_RATE',
      config: JSON.stringify({ scope: 'GLOBAL', thresholdPct: 10, windowDays: 30 }),
    });
    prisma.order.count
      .mockResolvedValueOnce(100) // total
      .mockResolvedValueOnce(20); // refunded
    const result = await engine.scanRule(r as any);
    expect(result.matched).toBe(1);
    expect(result.flagsCreated).toBe(0);
  });

  it('scanRule REFUND_RATE / USER: creates flag per offending user', async () => {
    const r = rule({
      ruleType: 'REFUND_RATE',
      config: JSON.stringify({ scope: 'USER', thresholdPct: 10, windowDays: 30 }),
    });
    prisma.$queryRaw.mockResolvedValueOnce([
      { user_id: 'u1', total: 10, refunded: 4, pct: 40 },
    ]);
    const result = await engine.scanRule(r as any);
    expect(result.matched).toBe(1);
    expect(flags.createFlag).toHaveBeenCalled();
  });

  it('scanRule with action=DISABLE_KEY: disables api keys + bumps confirmed', async () => {
    const r = rule({ action: 'DISABLE_KEY' });
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    prisma.riskFlag.findFirst.mockResolvedValueOnce({ id: 'pendingFlag' });
    await engine.scanRule(r as any);
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', isActive: true, deletedAt: null },
      data: { isActive: false },
    });
  });

  it('scanRule with action=FREEZE_USER: deactivates user + flags PERMANENT_BAN', async () => {
    const r = rule({ action: 'FREEZE_USER' });
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    prisma.riskFlag.findFirst.mockResolvedValueOnce({ id: 'pendingFlag' });
    await engine.scanRule(r as any);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', isActive: true, deletedAt: null },
      data: { isActive: false },
    });
  });

  it('scanRule: dedup skips creating second flag within 24h', async () => {
    const r = rule();
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    prisma.riskFlag.findFirst.mockResolvedValueOnce({
      id: 'existing',
      triggeredAt: new Date(),
    });
    const result = await engine.scanRule(r as any);
    expect(result.matched).toBe(1);
    expect(result.flagsCreated).toBe(0);
    expect(flags.createFlag).not.toHaveBeenCalled();
  });

  // Regression for dedup-after-CONFIRMED bug. Before the fix, dedup only
  // looked at status=PENDING. For action=DISABLE_KEY/FREEZE_USER/BLOCK,
  // applyAction immediately flips the flag past PENDING (CONFIRMED /
  // PERMANENT_BAN), so the next 5-min tick would create a new flag every
  // cycle. Dedup must consider any non-RELEASED status.
  it('scanRule dedup considers CONFIRMED flag (action=DISABLE_KEY second tick)', async () => {
    const r = rule({ action: 'DISABLE_KEY' });
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    // Simulate prior tick: user already has a CONFIRMED flag from a
    // previous DISABLE_KEY firing within the last 24h.
    prisma.riskFlag.findFirst.mockResolvedValueOnce({
      id: 'priorConfirmed',
      status: 'CONFIRMED',
      triggeredAt: new Date(),
    });
    const result = await engine.scanRule(r as any);
    expect(result.matched).toBe(1);
    expect(result.flagsCreated).toBe(0);
    expect(flags.createFlag).not.toHaveBeenCalled();
    // Verify the dedup query (first findFirst call) passed
    // `status: { not: 'RELEASED' }` so it surfaces CONFIRMED /
    // PERMANENT_BAN flags too.
    const dedupCall = prisma.riskFlag.findFirst.mock.calls[0];
    expect(dedupCall?.[0]?.where?.status).toEqual({ not: 'RELEASED' });
  });

  it('scanRule dedup considers PERMANENT_BAN flag (action=FREEZE_USER second tick)', async () => {
    const r = rule({ action: 'FREEZE_USER' });
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    prisma.riskFlag.findFirst.mockResolvedValueOnce({
      id: 'priorBan',
      status: 'PERMANENT_BAN',
      triggeredAt: new Date(),
    });
    const result = await engine.scanRule(r as any);
    expect(result.flagsCreated).toBe(0);
    expect(flags.createFlag).not.toHaveBeenCalled();
  });
});

// ============================================================
// P2-A2: AlertEvent emission on RiskFlag creation (spec §7.1)
// ============================================================
describe('RiskEngineService — P2-A2 AlertEvent hook', () => {
  let engine: RiskEngineService;
  let prisma: any;
  let flags: any;
  let alertEvents: { createAlert: jest.Mock };

  const rule = (overrides: Record<string, unknown> = {}) => ({
    id: 'rule1',
    name: 'usage cap',
    ruleType: 'USAGE_THRESHOLD',
    config: JSON.stringify({
      metric: 'DAILY_TOKEN',
      threshold: 1000,
      windowSec: 86400,
    }),
    action: 'ALERT',
    isActive: true,
    triggerCount: 0,
    lastTriggeredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      riskRule: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      riskList: { findFirst: jest.fn() },
      riskFlag: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      apiKey: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      order: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    flags = {
      createFlag: jest.fn().mockResolvedValue({ id: 'flag-new-1' }),
    };
    alertEvents = { createAlert: jest.fn().mockResolvedValue(null) };

    const m = await Test.createTestingModule({
      providers: [
        RiskEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: RiskFlagsService, useValue: flags },
        { provide: AlertEventService, useValue: alertEvents },
      ],
    }).compile();
    engine = m.get(RiskEngineService);
  });

  it('ALERT action → severity=MEDIUM, category=SECURITY, sourceType=risk_flag', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    await engine.scanRule(rule({ action: 'ALERT' }) as any);

    // Wait microtask queue so the void-Promise alert fire-and-forget settles.
    await Promise.resolve();
    await Promise.resolve();

    expect(flags.createFlag).toHaveBeenCalledTimes(1);
    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    const arg = alertEvents.createAlert.mock.calls[0][0];
    expect(arg.category).toBe('SECURITY');
    expect(arg.severity).toBe('MEDIUM');
    expect(arg.sourceType).toBe('risk_flag');
    expect(arg.sourceId).toBe('flag-new-1');
    expect(arg.userId).toBe('u1');
    expect(arg.context).toMatchObject({
      ruleId: 'rule1',
      ruleType: 'USAGE_THRESHOLD',
      action: 'ALERT',
    });
  });

  it.each([
    ['BLOCK', 'CRITICAL'],
    ['FREEZE_USER', 'CRITICAL'],
    ['DISABLE_KEY', 'HIGH'],
    ['ALERT', 'MEDIUM'],
  ])('action=%s → severity=%s', async (action, expected) => {
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    // P2-A2 review fix(Important #2): 用 where 子句区分两类 findFirst,
    // 不再按调用顺序 stack mockResolvedValueOnce(脆弱)。
    //  - dedup 查询: where.status = { not: 'RELEASED' } → 返回 null(无重复)
    //  - applyAction 状态翻转查询: where.status = 'PENDING'
    //    * ALERT 不调 applyAction
    //    * 非 ALERT 需要拿到刚 createFlag 出的 PENDING flag 才能 update
    prisma.riskFlag.findFirst.mockImplementation((args: any) => {
      const status = args?.where?.status;
      if (status === 'PENDING') {
        return Promise.resolve(
          action !== 'ALERT' ? { id: 'pendingFlag' } : null,
        );
      }
      return Promise.resolve(null);
    });
    await engine.scanRule(rule({ action }) as any);
    await Promise.resolve();
    await Promise.resolve();
    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    expect(alertEvents.createAlert.mock.calls[0][0].severity).toBe(expected);
  });

  it('createAlert throwing does NOT roll back RiskFlag creation', async () => {
    alertEvents.createAlert.mockRejectedValue(new Error('alert DB down'));
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    const result = await engine.scanRule(rule() as any);
    // Wait a tick so the .catch on the fire-and-forget promise lands.
    await Promise.resolve();
    await Promise.resolve();
    expect(flags.createFlag).toHaveBeenCalledTimes(1);
    expect(result.matched).toBe(1);
    expect(result.flagsCreated).toBe(1);
  });

  it('dedup hit (existing flag in 24h) → no createFlag, no createAlert', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1', total: 5000 }]);
    prisma.riskFlag.findFirst.mockResolvedValueOnce({
      id: 'existing',
      status: 'PENDING',
      triggeredAt: new Date(),
    });
    await engine.scanRule(rule() as any);
    await Promise.resolve();
    expect(flags.createFlag).not.toHaveBeenCalled();
    expect(alertEvents.createAlert).not.toHaveBeenCalled();
  });
});
