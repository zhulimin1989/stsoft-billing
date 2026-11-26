import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RiskFlagsService } from './risk-flags.service';

describe('RiskFlagsService', () => {
  let service: RiskFlagsService;
  let prisma: any;

  const baseFlag = (overrides: Record<string, unknown> = {}) => ({
    id: 'f1',
    userId: 'u1',
    ruleId: 'r1',
    ruleType: 'USAGE_THRESHOLD',
    severity: 'MEDIUM',
    context: JSON.stringify({ ip: '1.2.3.4' }),
    status: 'PENDING',
    triggeredAt: new Date('2026-04-26'),
    resolvedAt: null,
    resolvedBy: null,
    resolveNote: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      riskFlag: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: {
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          user: prisma.user,
          riskFlag: prisma.riskFlag,
        }),
      ),
    };
    const m = await Test.createTestingModule({
      providers: [
        RiskFlagsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = m.get(RiskFlagsService);
  });

  it('list: returns mapped items with parsed context', async () => {
    prisma.riskFlag.findMany.mockResolvedValueOnce([
      {
        ...baseFlag(),
        user: { id: 'u1', email: 'a@b.com', nickname: 'alice' },
        rule: { id: 'r1', name: 'rule one' },
      },
    ]);
    prisma.riskFlag.count.mockResolvedValueOnce(1);
    const out = await service.list({ page: 1, pageSize: 20 });
    expect(out.total).toBe(1);
    expect(out.items[0].userEmail).toBe('a@b.com');
    expect(out.items[0].ruleName).toBe('rule one');
    expect((out.items[0].context as any).ip).toBe('1.2.3.4');
  });

  it('getById: NotFound when missing', async () => {
    prisma.riskFlag.findUnique.mockResolvedValueOnce(null);
    await expect(service.getById('missing')).rejects.toThrow(NotFoundException);
  });

  it('createFlag: rejects bad ruleType / severity', async () => {
    await expect(
      service.createFlag({
        userId: 'u1',
        ruleType: 'X' as any,
        severity: 'HIGH',
      }),
    ).rejects.toThrow(/ruleType/);
    await expect(
      service.createFlag({
        userId: 'u1',
        ruleType: 'IP_LIMIT',
        severity: 'X' as any,
      }),
    ).rejects.toThrow(/severity/);
  });

  it('createFlag: persists with default PENDING status', async () => {
    prisma.riskFlag.create.mockResolvedValueOnce({ id: 'f2' });
    await service.createFlag({
      userId: 'u1',
      ruleType: 'IP_LIMIT',
      severity: 'HIGH',
      context: { ip: '1.2.3.4' },
    });
    expect(prisma.riskFlag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        ruleType: 'IP_LIMIT',
        status: 'PENDING',
      }),
    });
  });

  it('release: rejects when already released', async () => {
    prisma.riskFlag.findUnique.mockResolvedValueOnce(
      baseFlag({ status: 'RELEASED' }),
    );
    await expect(
      service.release('f1', 'admin1', 'note'),
    ).rejects.toThrow(BadRequestException);
  });

  it('release: marks status RELEASED + records operator + note', async () => {
    prisma.riskFlag.findUnique.mockResolvedValueOnce(baseFlag());
    prisma.riskFlag.update.mockResolvedValueOnce(
      baseFlag({ status: 'RELEASED' }),
    );
    const out = await service.release('f1', 'admin1', 'manual unblock');
    expect(out.status).toBe('RELEASED');
    expect(prisma.riskFlag.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: expect.objectContaining({
        status: 'RELEASED',
        resolvedBy: 'admin1',
        resolveNote: 'manual unblock',
      }),
    });
  });

  it('permanentBan: also flips user.isActive=false (deletedAt-safe)', async () => {
    prisma.riskFlag.findUnique.mockResolvedValueOnce(baseFlag());
    prisma.riskFlag.update.mockResolvedValueOnce(
      baseFlag({ status: 'PERMANENT_BAN' }),
    );
    await service.permanentBan('f1', 'admin1', 'fraud');
    // Mirrors applyAction → FREEZE_USER: filter on deletedAt:null so soft-
    // deleted users are not resurrected.
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', deletedAt: null },
      data: { isActive: false },
    });
  });

  it('related: returns TODO mode when no IP signal', async () => {
    prisma.riskFlag.findUnique.mockResolvedValueOnce(
      baseFlag({ context: '{}' }),
    );
    const out = await service.related('f1');
    expect(out.mode).toBe('TODO');
    expect(out.items).toEqual([]);
  });

  it('related: groups same-IP users by user', async () => {
    prisma.riskFlag.findUnique.mockResolvedValueOnce(
      baseFlag({ context: JSON.stringify({ ip: '1.2.3.4' }) }),
    );
    prisma.riskFlag.findMany.mockResolvedValueOnce([
      {
        ...baseFlag({ id: 'f2', userId: 'u2' }),
        user: { id: 'u2', email: 'b@b.com', nickname: 'bob' },
      },
      {
        ...baseFlag({ id: 'f3', userId: 'u2' }),
        user: { id: 'u2', email: 'b@b.com', nickname: 'bob' },
      },
      // same as subject — should be filtered out
      {
        ...baseFlag({ id: 'f4', userId: 'u1' }),
        user: { id: 'u1', email: 'a@b.com', nickname: 'alice' },
      },
    ]);
    const out = await service.related('f1');
    expect(out.mode).toBe('IP');
    expect(out.items).toHaveLength(1);
    expect(out.items[0].userId).toBe('u2');
    expect(out.items[0].flagCount).toBe(2);
  });
});
