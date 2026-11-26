import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TicketsService } from './tickets.service';

describe('TicketsService', () => {
  let service: TicketsService;
  let prisma: any;
  let redis: any;

  const baseTicket = (overrides: Record<string, unknown> = {}) => ({
    id: 't1',
    ticketNumber: 'TKT-20260427-00001',
    userId: 'u1',
    subject: 'help',
    category: 'BILLING',
    priority: 'NORMAL',
    status: 'OPEN',
    assigneeId: null,
    createdAt: new Date('2026-04-27T00:00:00Z'),
    resolvedAt: null,
    closedAt: null,
    updatedAt: new Date('2026-04-27T00:00:00Z'),
    ...overrides,
  });

  const baseMessage = (overrides: Record<string, unknown> = {}) => ({
    id: 'm1',
    ticketId: 't1',
    authorType: 'USER',
    authorId: 'u1',
    content: 'hi',
    attachments: '[]',
    isInternal: false,
    createdAt: new Date('2026-04-27T00:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      ticket: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      ticketMessage: {
        findMany: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      subscriptionPeriod: { findFirst: jest.fn().mockResolvedValue(null) },
      order: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      alertEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prisma);
        return Promise.all(fn);
      }),
    };
    redis = {
      incr: jest.fn(),
      expire: jest.fn(),
    };
    const m = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = m.get(TicketsService);
  });

  // ---------------- ticketNumber ----------------

  it('generateTicketNumber: redis incr → padded format', async () => {
    redis.incr.mockResolvedValueOnce(7);
    redis.expire.mockResolvedValueOnce(1);
    const n = await service.generateTicketNumber();
    expect(n).toMatch(/^TKT-\d{8}-00007$/);
    expect(redis.expire).toHaveBeenCalledWith(
      expect.stringContaining('ticket:counter:'),
      86400 * 2,
    );
  });

  it('generateTicketNumber: redis failure falls back to FBxxxxxx', async () => {
    redis.incr.mockRejectedValueOnce(new Error('connection refused'));
    const n = await service.generateTicketNumber();
    expect(n).toMatch(/^TKT-\d{8}-FB[A-Z0-9]{6}$/);
  });

  // ---------------- create ----------------

  it('create: rejects missing fields / bad enums', async () => {
    await expect(
      service.create({
        userId: '',
        subject: 's',
        category: 'BILLING',
      } as any),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({
        userId: 'u1',
        subject: '',
        category: 'BILLING',
      }),
    ).rejects.toThrow(/subject/);
    await expect(
      service.create({
        userId: 'u1',
        subject: 's',
        category: 'BAD' as any,
      }),
    ).rejects.toThrow(/category/);
  });

  it('create: user not found rejected', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.create({
        userId: 'missing',
        subject: 'help',
        category: 'BILLING',
      }),
    ).rejects.toThrow(/userId 不存在/);
  });

  it('create: happy path with initialContent creates USER message', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
    redis.incr.mockResolvedValueOnce(1);
    prisma.ticket.create.mockResolvedValueOnce(baseTicket());
    prisma.ticketMessage.create.mockResolvedValueOnce(baseMessage());

    const t = await service.create({
      userId: 'u1',
      subject: 'help',
      category: 'BILLING',
      initialContent: 'I need help',
    });
    expect(t.id).toBe('t1');
    expect(prisma.ticketMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorType: 'USER',
        authorId: 'u1',
        content: 'I need help',
      }),
    });
  });

  it('create: asAdminId routes initial message as ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
    redis.incr.mockResolvedValueOnce(2);
    prisma.ticket.create.mockResolvedValueOnce(baseTicket());
    prisma.ticketMessage.create.mockResolvedValueOnce(baseMessage());

    await service.create({
      userId: 'u1',
      subject: 'help',
      category: 'BILLING',
      initialContent: 'opened on behalf',
      asAdminId: 'admin42',
    });
    expect(prisma.ticketMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorType: 'ADMIN',
        authorId: 'admin42',
      }),
    });
  });

  // ---------------- detail ----------------

  it('getDetail: returns ticket + messages with attachments parsed', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce({
      ...baseTicket(),
      user: { id: 'u1', email: 'a@b.com', nickname: 'A' },
    });
    prisma.ticketMessage.findMany.mockResolvedValueOnce([
      baseMessage({ attachments: JSON.stringify(['/x', '/y']) }),
    ]);
    const d = await service.getDetail('t1', { includeInternal: true });
    expect(d.messages[0].attachments).toEqual(['/x', '/y']);
    expect(d.user?.email).toBe('a@b.com');
  });

  it('getDetail: filters internal messages when includeInternal=false', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce({
      ...baseTicket(),
      user: null,
    });
    prisma.ticketMessage.findMany.mockResolvedValueOnce([]);
    await service.getDetail('t1', { includeInternal: false });
    expect(prisma.ticketMessage.findMany).toHaveBeenCalledWith({
      where: { ticketId: 't1', isInternal: false },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('getDetail: rejects cross-user access', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce({
      ...baseTicket({ userId: 'u1' }),
      user: null,
    });
    await expect(
      service.getDetail('t1', { includeInternal: false, userId: 'u2' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('getDetail: 404 when not found', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.getDetail('missing', { includeInternal: true }),
    ).rejects.toThrow(NotFoundException);
  });

  // ---------------- addMessage ----------------

  it('addMessage: USER cannot reply to CLOSED', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'CLOSED' }),
    );
    await expect(
      service.addMessage('t1', {
        authorType: 'USER',
        authorId: 'u1',
        content: 'hi',
      }),
    ).rejects.toThrow(/已关闭/);
  });

  it('addMessage: ADMIN reply on OPEN advances to IN_PROGRESS', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'OPEN' }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(
      baseMessage({ authorType: 'ADMIN', isInternal: false }),
    );
    prisma.ticket.update.mockResolvedValue(baseTicket({ status: 'IN_PROGRESS' }));

    await service.addMessage('t1', {
      authorType: 'ADMIN',
      authorId: 'admin1',
      content: 'on it',
    });
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'IN_PROGRESS' },
    });
  });

  it('addMessage: USER reply on RESOLVED reopens to IN_PROGRESS and clears resolvedAt', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'RESOLVED', resolvedAt: new Date() }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(
      baseMessage({ authorType: 'USER', isInternal: false }),
    );
    prisma.ticket.update.mockResolvedValue(
      baseTicket({ status: 'IN_PROGRESS', resolvedAt: null }),
    );
    await service.addMessage('t1', {
      authorType: 'USER',
      authorId: 'u1',
      content: 'still broken',
    });
    const calls = prisma.ticket.update.mock.calls;
    expect(
      calls.some(
        ([arg]: any) =>
          arg.data?.status === 'IN_PROGRESS' && arg.data?.resolvedAt === null,
      ),
    ).toBe(true);
  });

  it('addMessage: ADMIN reply on RESOLVED does NOT auto-reopen', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'RESOLVED', resolvedAt: new Date() }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(
      baseMessage({ authorType: 'ADMIN', isInternal: false }),
    );
    prisma.ticket.update.mockResolvedValue(baseTicket());
    await service.addMessage('t1', {
      authorType: 'ADMIN',
      authorId: 'admin1',
      content: 'follow-up',
    });
    const calls = prisma.ticket.update.mock.calls;
    // Only the updatedAt bump — no status mutation triggered by ADMIN on RESOLVED.
    expect(
      calls.some(([arg]: any) => arg.data?.status === 'IN_PROGRESS'),
    ).toBe(false);
  });

  it('addMessage: internal note does NOT advance status', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'OPEN' }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(
      baseMessage({ authorType: 'ADMIN', isInternal: true }),
    );
    prisma.ticket.update.mockResolvedValue(baseTicket());
    await service.addMessage('t1', {
      authorType: 'ADMIN',
      authorId: 'admin1',
      content: 'note',
      isInternal: true,
    });
    // Only the updatedAt bump, never a status: IN_PROGRESS update.
    const calls = prisma.ticket.update.mock.calls;
    expect(
      calls.some(([arg]: any) => arg.data?.status === 'IN_PROGRESS'),
    ).toBe(false);
  });

  it('addMessage: rejects bad attachments', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(baseTicket());
    await expect(
      service.addMessage('t1', {
        authorType: 'USER',
        authorId: 'u1',
        content: 'hi',
        attachments: 'not-array' as any,
      }),
    ).rejects.toThrow(/数组/);
  });

  // ---------------- changeStatus ----------------

  it('changeStatus: rejects illegal transition CLOSED → OPEN', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'CLOSED' }),
    );
    await expect(
      service.changeStatus('t1', 'OPEN', 'admin1'),
    ).rejects.toThrow(/不允许/);
  });

  it('changeStatus: CLOSED → IN_PROGRESS clears closedAt', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'CLOSED', closedAt: new Date() }),
    );
    prisma.ticket.update.mockResolvedValueOnce(
      baseTicket({ status: 'IN_PROGRESS', closedAt: null }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(baseMessage());
    const r = await service.changeStatus('t1', 'IN_PROGRESS', 'admin1');
    expect(r.status).toBe('IN_PROGRESS');
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({
        status: 'IN_PROGRESS',
        closedAt: null,
        resolvedAt: null,
      }),
    });
  });

  it('changeStatus: OPEN → RESOLVED sets resolvedAt + writes audit message', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'OPEN' }),
    );
    prisma.ticket.update.mockResolvedValueOnce(
      baseTicket({ status: 'RESOLVED' }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(baseMessage());
    await service.changeStatus('t1', 'RESOLVED', 'admin1');
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({
        status: 'RESOLVED',
        resolvedAt: expect.any(Date),
      }),
    });
    expect(prisma.ticketMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorType: 'SYSTEM',
        isInternal: true,
        content: expect.stringMatching(/OPEN.*RESOLVED/),
      }),
    });
  });

  it('changeStatus: same status is a no-op', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ status: 'OPEN' }),
    );
    prisma.ticket.findUniqueOrThrow.mockResolvedValueOnce(baseTicket());
    const r = await service.changeStatus('t1', 'OPEN', 'admin1');
    expect(r.id).toBe('t1');
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  // ---------------- assign / category / priority ----------------

  it('assign: writes audit + updates assigneeId', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ assigneeId: null }),
    );
    prisma.ticket.update.mockResolvedValueOnce(
      baseTicket({ assigneeId: 'admin2' }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(baseMessage());
    const r = await service.assign('t1', 'admin2', 'admin1');
    expect(r.assigneeId).toBe('admin2');
  });

  it('changeCategory: rejects bad value', async () => {
    await expect(
      service.changeCategory('t1', 'BAD' as any, 'admin1'),
    ).rejects.toThrow(/category/);
  });

  it('changePriority: writes audit + updates', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ priority: 'NORMAL' }),
    );
    prisma.ticket.update.mockResolvedValueOnce(
      baseTicket({ priority: 'HIGH' }),
    );
    prisma.ticketMessage.create.mockResolvedValueOnce(baseMessage());
    const r = await service.changePriority('t1', 'HIGH', 'admin1');
    expect(r.priority).toBe('HIGH');
  });

  // ---------------- merge ----------------

  it('merge: rejects merging into self', async () => {
    await expect(service.merge('t1', 't1', 'admin1')).rejects.toThrow(/自身/);
  });

  it('merge: rejects when src is CLOSED', async () => {
    prisma.ticket.findUnique
      .mockResolvedValueOnce(baseTicket({ id: 't1', status: 'CLOSED' }))
      .mockResolvedValueOnce(baseTicket({ id: 't2' }));
    await expect(service.merge('t1', 't2', 'admin1')).rejects.toThrow(
      /已关闭/,
    );
  });

  it('merge: rejects cross-user merge (privacy)', async () => {
    prisma.ticket.findUnique
      .mockResolvedValueOnce(baseTicket({ id: 't1', userId: 'userA' }))
      .mockResolvedValueOnce(baseTicket({ id: 't2', userId: 'userB' }));
    await expect(service.merge('t1', 't2', 'admin1')).rejects.toThrow(
      /不同用户/,
    );
    // No mutations attempted.
    expect(prisma.ticketMessage.updateMany).not.toHaveBeenCalled();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('merge: re-parents messages, marks src CLOSED, leaves audit trail', async () => {
    prisma.ticket.findUnique
      .mockResolvedValueOnce(
        baseTicket({ id: 't1', ticketNumber: 'TKT-A', status: 'OPEN' }),
      )
      .mockResolvedValueOnce(
        baseTicket({ id: 't2', ticketNumber: 'TKT-B' }),
      );
    prisma.ticketMessage.updateMany.mockResolvedValueOnce({ count: 3 });
    prisma.ticketMessage.create.mockResolvedValue(baseMessage());
    prisma.ticket.update
      .mockResolvedValueOnce(baseTicket({ id: 't1', status: 'CLOSED' }))
      .mockResolvedValueOnce(baseTicket({ id: 't2' }));

    const r = await service.merge('t1', 't2', 'admin1');
    expect(r.src.status).toBe('CLOSED');
    expect(prisma.ticketMessage.updateMany).toHaveBeenCalledWith({
      where: { ticketId: 't1' },
      data: { ticketId: 't2' },
    });
    // Two SYSTEM markers (one per ticket)
    expect(prisma.ticketMessage.create).toHaveBeenCalledTimes(2);
  });

  // ---------------- SLA scan ----------------

  it('checkSla: OPEN ticket past SLA emits one alert', async () => {
    const pastTime = new Date(Date.now() - 2 * 3600_000); // 2h ago
    prisma.ticket.findMany.mockImplementation((args: any) => {
      // URGENT priority window catches 2h-old tickets
      if (args.where.priority === 'URGENT') {
        return Promise.resolve([
          {
            id: 't1',
            ticketNumber: 'TKT-X',
            priority: 'URGENT',
            status: 'OPEN',
            createdAt: pastTime,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    prisma.alertEvent.findFirst.mockResolvedValue(null);
    prisma.alertEvent.create.mockResolvedValue({ id: 'event1' });

    const r = await service.checkSla();
    expect(r.alerted).toBe(1);
    expect(prisma.alertEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        category: 'SYSTEM',
        severity: 'CRITICAL',
        sourceType: 'ticket.sla.overdue',
        sourceId: 't1',
      }),
    });
  });

  it('checkSla: dedup skips already-alerted tickets within 24h', async () => {
    prisma.ticket.findMany.mockImplementation((args: any) => {
      if (args.where.priority === 'URGENT') {
        return Promise.resolve([
          {
            id: 't1',
            ticketNumber: 'TKT-X',
            priority: 'URGENT',
            status: 'OPEN',
            createdAt: new Date(Date.now() - 2 * 3600_000),
          },
        ]);
      }
      return Promise.resolve([]);
    });
    prisma.alertEvent.findFirst.mockResolvedValue({ id: 'prev' });

    const r = await service.checkSla();
    expect(r.alerted).toBe(0);
    expect(r.overdue).toBe(1);
    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
  });

  // ---------------- user-side ----------------

  it('replyForUser: blocks cross-user reply', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(
      baseTicket({ userId: 'u1' }),
    );
    await expect(
      service.replyForUser('t1', 'u2', 'hi'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('replyForUser: 404 when ticket missing', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.replyForUser('missing', 'u1', 'hi'),
    ).rejects.toThrow(NotFoundException);
  });

  it('replyForUser: forces authorType=USER and isInternal=false', async () => {
    prisma.ticket.findUnique
      .mockResolvedValueOnce(baseTicket({ userId: 'u1' }))
      .mockResolvedValueOnce(baseTicket({ userId: 'u1' }));
    prisma.ticketMessage.create.mockResolvedValueOnce(baseMessage());
    prisma.ticket.update.mockResolvedValue(baseTicket());
    await service.replyForUser('t1', 'u1', 'thx');
    expect(prisma.ticketMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorType: 'USER',
        authorId: 'u1',
        isInternal: false,
      }),
    });
  });
});
