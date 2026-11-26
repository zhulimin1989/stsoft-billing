import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserSegmentsService } from './user-segments.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Service tests against an in-memory Prisma stub. Rule resolution is exercised
 * via the rule-engine spec; here we focus on service-layer business rules:
 * CRUD, member management, refresh.
 */
describe('UserSegmentsService', () => {
  let service: UserSegmentsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = makePrismaStub();
    const m = await Test.createTestingModule({
      providers: [
        UserSegmentsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = m.get(UserSegmentsService);
  });

  // ---------- create ----------

  it('create: rejects missing name', async () => {
    await expect(
      service.create({ name: '', ruleType: 'STATIC' as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects bad ruleType', async () => {
    await expect(
      service.create({ name: 'x', ruleType: 'WHATEVER' as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects DYNAMIC with malformed ruleExpr', async () => {
    await expect(
      service.create({
        name: 'x',
        ruleType: 'DYNAMIC' as any,
        ruleExpr: 'not json',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: persists STATIC segment', async () => {
    const created = { id: 's1', name: 'foo', ruleType: 'STATIC' };
    prisma.userSegment.create.mockResolvedValueOnce(created);
    const r = await service.create({ name: 'foo', ruleType: 'STATIC' as any });
    expect(r).toEqual(created);
    expect(prisma.userSegment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'foo', ruleType: 'STATIC' }),
    });
  });

  // ---------- get / list / update / softDelete ----------

  it('getById: throws on not found', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce(null);
    await expect(service.getById('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list: passes filters into where', async () => {
    prisma.userSegment.findMany.mockResolvedValueOnce([]);
    prisma.userSegment.count.mockResolvedValueOnce(0);
    await service.list({
      page: 2,
      pageSize: 10,
      search: 'high',
      ruleType: 'DYNAMIC' as any,
      isActive: true,
    });
    const args = prisma.userSegment.findMany.mock.calls[0][0];
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.ruleType).toBe('DYNAMIC');
    expect(args.where.isActive).toBe(true);
    expect(args.where.OR).toBeDefined();
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
  });

  it('update: rejects malformed ruleExpr', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce({ id: 's1' });
    await expect(
      service.update('s1', { ruleExpr: 'oops' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update: applies partial fields', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce({
      id: 's1',
      name: 'old',
    });
    prisma.userSegment.update.mockResolvedValueOnce({
      id: 's1',
      name: 'new',
    });
    await service.update('s1', { name: 'new', isActive: false });
    const args = prisma.userSegment.update.mock.calls[0][0];
    expect(args.data).toEqual({ name: 'new', isActive: false });
  });

  it('softDelete: sets deletedAt + isActive=false', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce({ id: 's1' });
    prisma.userSegment.update.mockResolvedValueOnce({});
    await service.softDelete('s1');
    const args = prisma.userSegment.update.mock.calls[0][0];
    expect(args.data.deletedAt).toBeInstanceOf(Date);
    expect(args.data.isActive).toBe(false);
  });

  // ---------- members / refresh ----------

  it('addMembers: rejects on DYNAMIC segment', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce({
      id: 's1',
      ruleType: 'DYNAMIC',
    });
    await expect(service.addMembers('s1', ['u1'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('addMembers: STATIC — inserts only existing users, returns missing list', async () => {
    prisma.userSegment.findFirst.mockResolvedValue({
      id: 's1',
      ruleType: 'STATIC',
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'u1' }, { id: 'u2' }]);
    prisma.userSegmentMember.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.userSegmentMember.count.mockResolvedValueOnce(2); // refresh path
    prisma.userSegment.update.mockResolvedValueOnce({});

    const r = await service.addMembers('s1', ['u1', 'u2', 'u-missing']);
    expect(r).toEqual({ added: 2, skipped: 0, missing: ['u-missing'] });
    expect(prisma.userSegmentMember.createMany).toHaveBeenCalledWith({
      data: [
        { segmentId: 's1', userId: 'u1' },
        { segmentId: 's1', userId: 'u2' },
      ],
      skipDuplicates: true,
    });
    // refresh call writes the new memberCount
    expect(prisma.userSegment.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { memberCount: 2 },
    });
  });

  it('addMembers: rejects empty array', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce({
      id: 's1',
      ruleType: 'STATIC',
    });
    await expect(service.addMembers('s1', [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('removeMember: STATIC — deletes & refreshes count', async () => {
    prisma.userSegment.findFirst.mockResolvedValue({
      id: 's1',
      ruleType: 'STATIC',
    });
    prisma.userSegmentMember.deleteMany.mockResolvedValueOnce({ count: 1 });
    prisma.userSegmentMember.count.mockResolvedValueOnce(0);
    prisma.userSegment.update.mockResolvedValueOnce({});
    await service.removeMember('s1', 'u1');
    expect(prisma.userSegmentMember.deleteMany).toHaveBeenCalledWith({
      where: { segmentId: 's1', userId: 'u1' },
    });
  });

  it('refresh: STATIC counts member rows', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce({
      id: 's1',
      ruleType: 'STATIC',
    });
    prisma.userSegmentMember.count.mockResolvedValueOnce(7);
    prisma.userSegment.update.mockResolvedValueOnce({
      id: 's1',
      memberCount: 7,
    });
    await service.refresh('s1');
    expect(prisma.userSegment.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { memberCount: 7 },
    });
  });

  it('refresh: DYNAMIC resolves rule and writes count', async () => {
    prisma.userSegment.findFirst.mockResolvedValueOnce({
      id: 's2',
      ruleType: 'DYNAMIC',
      ruleExpr: JSON.stringify({
        field: 'subscriptionStatus',
        op: '=',
        value: 'ACTIVE',
      }),
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    prisma.userSegment.update.mockResolvedValueOnce({});
    await service.refresh('s2');
    expect(prisma.userSegment.update).toHaveBeenCalledWith({
      where: { id: 's2' },
      data: { memberCount: 3 },
    });
  });

  it('refreshAllDynamic: returns ok/failed counts and continues past errors', async () => {
    prisma.userSegment.findMany.mockResolvedValueOnce([
      { id: 'a', ruleExpr: JSON.stringify({ field: 'subscriptionStatus', op: '=', value: 'ACTIVE' }) },
      { id: 'b', ruleExpr: 'not-json' }, // will fail
      { id: 'c', ruleExpr: JSON.stringify({ field: 'emailDomain', op: '=', value: 'a.com' }) },
    ]);
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{ id: 'u2' }, { id: 'u3' }]);
    prisma.userSegment.update.mockResolvedValue({});
    const r = await service.refreshAllDynamic();
    expect(r).toEqual({ ok: 2, failed: 1 });
  });

  // ---------- preview ----------

  it('preview: returns matchedCount and capped sample', async () => {
    prisma.user.findMany.mockResolvedValueOnce(
      Array.from({ length: 120 }, (_, i) => ({ id: `u${i}` })),
    );
    const r = await service.preview(
      JSON.stringify({ field: 'subscriptionStatus', op: '=', value: 'ACTIVE' }),
    );
    expect(r.matchedCount).toBe(120);
    expect(r.sampleUserIds.length).toBe(50); // PREVIEW_SAMPLE_LIMIT
  });

  it('preview: rejects empty body', async () => {
    await expect(service.preview('')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('preview: returns capped:true when engine signals match-too-large', async () => {
    // Engine resolves the leaf via prisma.user.findMany; if findMany returns
    // > MAX_RESOLVE_SIZE rows the engine throws RuleMatchTooLargeError, which
    // service.preview must translate to capped:true.
    const { MAX_RESOLVE_SIZE } = await import('./user-segment-rule-engine');
    prisma.user.findMany.mockResolvedValueOnce(
      Array.from({ length: MAX_RESOLVE_SIZE + 1 }, (_, i) => ({ id: `u${i}` })),
    );
    const r = await service.preview(
      JSON.stringify({ field: 'subscriptionStatus', op: '=', value: 'ACTIVE' }),
    );
    expect(r.capped).toBe(true);
    expect(r.matchedCount).toBe(-1);
    expect(r.sampleUserIds).toEqual([]);
    expect(r.message).toMatch(/too many users/);
  });
});

// ---------- prisma stub factory ----------
function makePrismaStub() {
  return {
    userSegment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    userSegmentMember: {
      createMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
}
