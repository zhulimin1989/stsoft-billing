import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertEventService } from './alert-events.service';

describe('AlertEventService', () => {
  let service: AlertEventService;
  let prisma: any;

  const baseAlert = (overrides: Record<string, unknown> = {}) => ({
    id: 'a1',
    category: 'PAYMENT',
    severity: 'HIGH',
    status: 'PENDING',
    title: 't',
    message: 'm',
    sourceType: 'order',
    sourceId: 'o1',
    userId: 'u1',
    context: '{}',
    readAt: null,
    handledAt: null,
    handledBy: null,
    handleNote: null,
    createdAt: new Date('2026-04-30T10:00:00Z'),
    updatedAt: new Date('2026-04-30T10:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      alertEvent: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
    };
    const m = await Test.createTestingModule({
      providers: [
        AlertEventService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = m.get(AlertEventService);
  });

  // ============================ createAlert ============================

  describe('createAlert', () => {
    it('persists when no recent duplicate exists', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      prisma.alertEvent.create.mockResolvedValueOnce(baseAlert({ id: 'new1' }));

      const out = await service.createAlert({
        category: 'PAYMENT',
        severity: 'HIGH',
        title: 'fulfillOrder failed',
        message: 'something exploded',
        sourceType: 'order',
        sourceId: 'o1',
        userId: 'u1',
        context: { amount: 100 },
      });

      expect(out?.id).toBe('new1');
      expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
      const data = prisma.alertEvent.create.mock.calls[0][0].data;
      expect(data.category).toBe('PAYMENT');
      expect(data.context).toBe(JSON.stringify({ amount: 100 }));
    });

    it('skips creation when a recent PENDING/READ alert with same key exists (5min dedup)', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce({ id: 'existing' });
      const out = await service.createAlert({
        category: 'PAYMENT',
        severity: 'HIGH',
        title: 't',
        message: 'm',
        sourceType: 'order',
        sourceId: 'o1',
      });
      expect(out).toBeNull();
      expect(prisma.alertEvent.create).not.toHaveBeenCalled();

      // Verify the dedup query: status filtered to PENDING/READ + createdAt >= now-5min.
      const where = prisma.alertEvent.findFirst.mock.calls[0][0].where;
      expect(where.category).toBe('PAYMENT');
      expect(where.sourceType).toBe('order');
      expect(where.sourceId).toBe('o1');
      expect(where.status).toEqual({ in: ['PENDING', 'READ'] });
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      const windowMs = Date.now() - where.createdAt.gte.getTime();
      // Should be ~5 minutes (300000 ms). Allow generous slack for test scheduling.
      expect(windowMs).toBeGreaterThanOrEqual(4 * 60 * 1000);
      expect(windowMs).toBeLessThanOrEqual(6 * 60 * 1000);
    });

    it('does NOT throw when DB write fails — only logs warn', async () => {
      prisma.alertEvent.findFirst.mockRejectedValueOnce(new Error('PG down'));
      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      const out = await service.createAlert({
        category: 'CHANNEL',
        severity: 'CRITICAL',
        title: 't',
        message: 'm',
      });
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Ensure no crash even on prisma.alertEvent.create rejection.
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      prisma.alertEvent.create.mockRejectedValueOnce(new Error('disk full'));
      const out2 = await service.createAlert({
        category: 'CHANNEL',
        severity: 'CRITICAL',
        title: 't',
        message: 'm',
      });
      expect(out2).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('swallows P2002 unique violation race (concurrent dedup) → returns null, no throw', async () => {
      // findFirst 通过(无重复),但 create 时另一路已先写入触发 unique 约束。
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: 'test', meta: {} } as any,
      );
      prisma.alertEvent.create.mockRejectedValueOnce(p2002);

      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
      const debugSpy = jest
        .spyOn((service as any).logger, 'debug')
        .mockImplementation(() => undefined);

      const out = await service.createAlert({
        category: 'PAYMENT',
        severity: 'HIGH',
        title: 't',
        message: 'm',
        sourceType: 'order',
        sourceId: 'o1',
      });

      expect(out).toBeNull();
      // 静默路径:走 debug,不走 warn(否则 prod 日志会被刷屏)。
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('non-P2002 Prisma error still falls through to warn (returns null, no throw)', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      const p2003 = new Prisma.PrismaClientKnownRequestError(
        'FK violation',
        { code: 'P2003', clientVersion: 'test', meta: {} } as any,
      );
      prisma.alertEvent.create.mockRejectedValueOnce(p2003);

      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      const out = await service.createAlert({
        category: 'PAYMENT',
        severity: 'HIGH',
        title: 't',
        message: 'm',
      });
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('handles circular reference in context → fallback to "{}", does not throw', async () => {
      // 构造循环引用(RiskEngine 透传 axios error 等真实场景)。
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      prisma.alertEvent.create.mockResolvedValueOnce(baseAlert({ id: 'circ1' }));

      const out = await service.createAlert({
        category: 'SYSTEM',
        severity: 'LOW',
        title: 't',
        message: 'm',
        context: circular,
      });

      expect(out?.id).toBe('circ1');
      const data = prisma.alertEvent.create.mock.calls[0][0].data;
      // 循环引用 fallback 到 '{}',不应抛 TypeError。
      expect(data.context).toBe('{}');
    });

    it('treats null sourceType/sourceId as the dedup key (e.g. Stripe verify-fail)', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      prisma.alertEvent.create.mockResolvedValueOnce(baseAlert());
      await service.createAlert({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: 't',
        message: 'm',
      });
      const where = prisma.alertEvent.findFirst.mock.calls[0][0].where;
      expect(where.sourceType).toBeNull();
      expect(where.sourceId).toBeNull();
    });
  });

  // ============================ list ============================

  describe('list', () => {
    beforeEach(() => {
      prisma.alertEvent.findMany.mockResolvedValue([baseAlert()]);
      prisma.alertEvent.count.mockResolvedValue(1);
    });

    it('passes single-field filters through to where clause', async () => {
      await service.list({
        page: 1,
        pageSize: 10,
        category: 'PAYMENT',
        severity: 'HIGH',
        status: 'PENDING',
        userId: 'u1',
      });
      const where = prisma.alertEvent.findMany.mock.calls[0][0].where;
      expect(where.category).toBe('PAYMENT');
      expect(where.severity).toBe('HIGH');
      expect(where.status).toBe('PENDING');
      expect(where.userId).toBe('u1');
    });

    it('combines fromDate / toDate into createdAt range', async () => {
      const from = new Date('2026-04-01T00:00:00Z');
      const to = new Date('2026-04-30T23:59:59Z');
      await service.list({ page: 1, pageSize: 10, fromDate: from, toDate: to });
      const where = prisma.alertEvent.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte).toEqual(from);
      expect(where.createdAt.lte).toEqual(to);
    });

    it('q maps to OR(title, message) case-insensitive contains', async () => {
      await service.list({ page: 1, pageSize: 10, q: '订单失败' });
      const where = prisma.alertEvent.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { title: { contains: '订单失败', mode: 'insensitive' } },
        { message: { contains: '订单失败', mode: 'insensitive' } },
      ]);
    });

    it('clamps pageSize to 200 when caller passes 1000', async () => {
      await service.list({ page: 1, pageSize: 1000 });
      const args = prisma.alertEvent.findMany.mock.calls[0][0];
      expect(args.take).toBe(200);
    });

    it('combines all filters together', async () => {
      const from = new Date('2026-04-01T00:00:00Z');
      await service.list({
        page: 2,
        pageSize: 50,
        category: 'SECURITY',
        severity: 'CRITICAL',
        status: 'PENDING',
        userId: 'u1',
        fromDate: from,
        q: 'foo',
      });
      const args = prisma.alertEvent.findMany.mock.calls[0][0];
      expect(args.skip).toBe(50);
      expect(args.take).toBe(50);
      expect(args.where.category).toBe('SECURITY');
      expect(args.where.severity).toBe('CRITICAL');
      expect(args.where.status).toBe('PENDING');
      expect(args.where.userId).toBe('u1');
      expect(args.where.createdAt.gte).toEqual(from);
      expect(args.where.OR).toBeDefined();
    });

    it('returns paginated envelope', async () => {
      prisma.alertEvent.count.mockResolvedValueOnce(305);
      prisma.alertEvent.findMany.mockResolvedValueOnce([baseAlert(), baseAlert()]);
      const out = await service.list({ page: 1, pageSize: 100 });
      expect(out.total).toBe(305);
      expect(out.page).toBe(1);
      expect(out.pageSize).toBe(100);
      expect(out.totalPages).toBe(4);
      expect(out.items).toHaveLength(2);
    });
  });

  // ============================ getById / getStats ============================

  describe('getById', () => {
    it('returns row when found', async () => {
      prisma.alertEvent.findUnique.mockResolvedValueOnce(baseAlert());
      const out = await service.getById('a1');
      expect(out.id).toBe('a1');
    });

    it('throws NotFound when missing', async () => {
      prisma.alertEvent.findUnique.mockResolvedValueOnce(null);
      await expect(service.getById('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getStats', () => {
    it('returns three counts: unread (PENDING) / critical (CRITICAL non-HANDLED) / today', async () => {
      prisma.alertEvent.count
        .mockResolvedValueOnce(7) // unread
        .mockResolvedValueOnce(3) // critical
        .mockResolvedValueOnce(12); // today

      const out = await service.getStats();
      expect(out).toEqual({ unreadCount: 7, criticalCount: 3, todayCount: 12 });

      const callArgs = prisma.alertEvent.count.mock.calls;
      expect(callArgs[0][0].where).toEqual({ status: 'PENDING' });
      expect(callArgs[1][0].where).toEqual({
        severity: 'CRITICAL',
        status: { not: 'HANDLED' },
      });
      const startOfToday = callArgs[2][0].where.createdAt.gte;
      expect(startOfToday).toBeInstanceOf(Date);
      expect(startOfToday.getHours()).toBe(0);
      expect(startOfToday.getMinutes()).toBe(0);
      expect(startOfToday.getSeconds()).toBe(0);
    });
  });

  // ============================ markRead ============================

  describe('markRead', () => {
    it('updates only PENDING rows -> READ + readAt=now', async () => {
      prisma.alertEvent.updateMany.mockResolvedValueOnce({ count: 2 });
      const out = await service.markRead(['a1', 'a2', 'a3'], 'admin1');
      expect(out.updated).toBe(2);
      const args = prisma.alertEvent.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({
        id: { in: ['a1', 'a2', 'a3'] },
        status: 'PENDING',
      });
      expect(args.data.status).toBe('READ');
      expect(args.data.readAt).toBeInstanceOf(Date);
    });

    it('returns updated:0 for empty / non-array ids without hitting DB', async () => {
      const out1 = await service.markRead([], 'admin1');
      expect(out1.updated).toBe(0);
      const out2 = await service.markRead(undefined as any, 'admin1');
      expect(out2.updated).toBe(0);
      expect(prisma.alertEvent.updateMany).not.toHaveBeenCalled();
    });

    it('skips already-READ/HANDLED rows (filter is status=PENDING)', async () => {
      // The service-side filter ensures only PENDING rows transition; updateMany
      // count will be lower than ids.length when some rows are already READ/HANDLED.
      prisma.alertEvent.updateMany.mockResolvedValueOnce({ count: 1 });
      const out = await service.markRead(['pendingA', 'readB', 'handledC'], 'admin1');
      expect(out.updated).toBe(1);
      const where = prisma.alertEvent.updateMany.mock.calls[0][0].where;
      expect(where.status).toBe('PENDING');
    });
  });

  // ============================ handle ============================

  describe('handle', () => {
    it('PENDING -> HANDLED writes handledAt, handledBy, note + back-fills readAt', async () => {
      prisma.alertEvent.findUnique.mockResolvedValueOnce(
        baseAlert({ status: 'PENDING', readAt: null }),
      );
      prisma.alertEvent.update.mockResolvedValueOnce(
        baseAlert({ status: 'HANDLED' }),
      );
      const out = await service.handle('a1', 'admin1', '已联系用户解决');
      expect(out.status).toBe('HANDLED');
      const data = prisma.alertEvent.update.mock.calls[0][0].data;
      expect(data.status).toBe('HANDLED');
      expect(data.handledAt).toBeInstanceOf(Date);
      expect(data.handledBy).toBe('admin1');
      expect(data.handleNote).toBe('已联系用户解决');
      expect(data.readAt).toBeInstanceOf(Date);
    });

    it('READ -> HANDLED preserves existing readAt (does not overwrite)', async () => {
      const existingReadAt = new Date('2026-04-29T10:00:00Z');
      prisma.alertEvent.findUnique.mockResolvedValueOnce(
        baseAlert({ status: 'READ', readAt: existingReadAt }),
      );
      prisma.alertEvent.update.mockResolvedValueOnce(
        baseAlert({ status: 'HANDLED', readAt: existingReadAt }),
      );
      await service.handle('a1', 'admin1', 'note');
      const data = prisma.alertEvent.update.mock.calls[0][0].data;
      expect(data.readAt).toBeUndefined();
    });

    it('HANDLED throws BadRequest (idempotency guard)', async () => {
      prisma.alertEvent.findUnique.mockResolvedValueOnce(
        baseAlert({ status: 'HANDLED' }),
      );
      await expect(service.handle('a1', 'admin1', 'n')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.alertEvent.update).not.toHaveBeenCalled();
    });

    it('NotFound when id missing', async () => {
      prisma.alertEvent.findUnique.mockResolvedValueOnce(null);
      await expect(service.handle('x', 'admin1', 'n')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ============================ createSystemAlert (P2-A3 §8.2) ===========

  describe('createSystemAlert', () => {
    it('produces a SYSTEM/CRITICAL alert with metric as sourceId (5min dedup)', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      prisma.alertEvent.create.mockResolvedValueOnce(
        baseAlert({ id: 'sys1', category: 'SYSTEM' }),
      );

      const out = await service.createSystemAlert({
        metric: 'redis_unreachable',
        value: 0,
        threshold: 1,
        context: { error: 'ECONNREFUSED' },
      });

      expect(out?.id).toBe('sys1');
      const data = prisma.alertEvent.create.mock.calls[0][0].data;
      expect(data.category).toBe('SYSTEM');
      expect(data.severity).toBe('CRITICAL');
      expect(data.sourceType).toBe('system');
      expect(data.sourceId).toBe('redis_unreachable');
      expect(data.title).toContain('redis_unreachable');
      expect(data.message).toContain('redis_unreachable');
      const ctx = JSON.parse(data.context);
      expect(ctx).toMatchObject({
        metric: 'redis_unreachable',
        value: 0,
        threshold: 1,
        error: 'ECONNREFUSED',
      });
    });

    it('honors custom severity / title / message', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      prisma.alertEvent.create.mockResolvedValueOnce(
        baseAlert({ id: 'sys2', category: 'SYSTEM' }),
      );

      await service.createSystemAlert({
        metric: 'pg_replica_lag',
        value: 30,
        threshold: 10,
        severity: 'HIGH',
        title: 'PG replica lag too high',
        message: 'lag=30s threshold=10s',
      });

      const data = prisma.alertEvent.create.mock.calls[0][0].data;
      expect(data.severity).toBe('HIGH');
      expect(data.title).toBe('PG replica lag too high');
      expect(data.message).toBe('lag=30s threshold=10s');
    });

    it('swallows write failures (system alerts must never crash health probes)', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce(null);
      prisma.alertEvent.create.mockRejectedValueOnce(
        new Error('alert table down'),
      );

      // Must not throw
      const out = await service.createSystemAlert({
        metric: 'redis_unreachable',
        value: 0,
        threshold: 1,
      });
      expect(out).toBeNull();
    });

    it('hits 5min dedup when same metric was alerted recently', async () => {
      prisma.alertEvent.findFirst.mockResolvedValueOnce({ id: 'recent' });

      const out = await service.createSystemAlert({
        metric: 'redis_unreachable',
        value: 0,
        threshold: 1,
      });
      expect(out).toBeNull();
      expect(prisma.alertEvent.create).not.toHaveBeenCalled();
    });
  });
});
