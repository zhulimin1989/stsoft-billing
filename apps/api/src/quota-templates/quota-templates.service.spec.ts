import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { RollingQuotaGateService } from '../publisher/rolling-quota-gate.service';
import { QuotaRule, QuotaTemplatesService } from './quota-templates.service';

/**
 * Service tests use an in-memory Prisma stub. Focus is on rule validation,
 * unique-name handling, soft delete tombstoning, and clone semantics.
 */
describe('QuotaTemplatesService', () => {
  let service: QuotaTemplatesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = makePrismaStub();
    const m = await Test.createTestingModule({
      providers: [
        QuotaTemplatesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PublisherSyncService,
          useValue: { syncApiKeysByPlanId: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: RollingQuotaGateService,
          useValue: { invalidateRulesCache: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = m.get(QuotaTemplatesService);
  });

  const validRule = (overrides: Partial<QuotaRule> = {}): QuotaRule => ({
    windowType: 'ROLLING',
    durationLabel: '5h',
    durationSec: 18000,
    metric: 'REQUESTS',
    limitValue: 200,
    ...overrides,
  });

  // ---------- create / validation ----------

  it('create: rejects missing name', async () => {
    await expect(
      service.create({ name: '', rules: [validRule()] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects missing rules', async () => {
    await expect(
      service.create({ name: 'x', rules: undefined as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects rules not-an-array', async () => {
    await expect(
      service.create({ name: 'x', rules: '{"foo":1}' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects malformed JSON string for rules', async () => {
    await expect(
      service.create({ name: 'x', rules: 'not-json' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects too many rules (>16)', async () => {
    const rules = Array.from({ length: 17 }, () => validRule());
    await expect(
      service.create({ name: 'x', rules }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects bad windowType', async () => {
    await expect(
      service.create({
        name: 'x',
        rules: [validRule({ windowType: 'BOGUS' as any })],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects bad metric', async () => {
    await expect(
      service.create({
        name: 'x',
        rules: [validRule({ metric: 'NOPE' as any })],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects non-positive durationSec', async () => {
    await expect(
      service.create({
        name: 'x',
        rules: [validRule({ durationSec: 0 })],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects non-positive limitValue', async () => {
    await expect(
      service.create({
        name: 'x',
        rules: [validRule({ limitValue: -5 })],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: persists template and returns DTO with parsed rules', async () => {
    prisma.planQuotaTemplate.create.mockResolvedValueOnce({
      id: 't1',
      name: 'High',
      description: '',
      rules: JSON.stringify([validRule()]),
      isActive: true,
      createdAt: new Date('2026-04-01'),
      updatedAt: new Date('2026-04-01'),
      deletedAt: null,
    });
    const r = await service.create({
      name: 'High',
      rules: [validRule()],
    });
    expect(r.id).toBe('t1');
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].metric).toBe('REQUESTS');
    expect(r.referencedPlanIds).toEqual([]);
    // Stored as JSON string with description default ''
    const dataArg = prisma.planQuotaTemplate.create.mock.calls[0][0].data;
    expect(typeof dataArg.rules).toBe('string');
    expect(JSON.parse(dataArg.rules)).toHaveLength(1);
  });

  it('create: rejects an internally non-monotonic template (5h CREDITS > 7d CREDITS)', async () => {
    await expect(
      service.create({
        name: 't4',
        rules: [
          { windowType: 'ROLLING', metric: 'CREDITS', durationLabel: '5h', durationSec: 18000, limitValue: 5000 },
          { windowType: 'ROLLING', metric: 'CREDITS', durationLabel: '7d', durationSec: 604800, limitValue: 500 },
        ],
      }),
    ).rejects.toThrow(/不一致/);
    expect(prisma.planQuotaTemplate.create).not.toHaveBeenCalled();
  });

  it('update: rejects making the template internally non-monotonic', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      name: 't4',
      rules: '[]',
      isActive: true,
      deletedAt: null,
    });
    await expect(
      service.update('t1', {
        rules: [
          { windowType: 'ROLLING', metric: 'CREDITS', durationLabel: '5h', durationSec: 18000, limitValue: 5000 },
          { windowType: 'ROLLING', metric: 'CREDITS', durationLabel: '7d', durationSec: 604800, limitValue: 500 },
        ],
      }),
    ).rejects.toThrow(/不一致/);
    expect(prisma.planQuotaTemplate.update).not.toHaveBeenCalled();
  });

  it('create: accepts JSON string rules', async () => {
    prisma.planQuotaTemplate.create.mockResolvedValueOnce({
      id: 't2',
      name: 'Low',
      description: '',
      rules: JSON.stringify([validRule()]),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    await service.create({
      name: 'Low',
      rules: JSON.stringify([validRule()]),
    });
    expect(prisma.planQuotaTemplate.create).toHaveBeenCalled();
  });

  it('create: maps Prisma P2002 unique violation to ConflictException', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'unique violation',
      { code: 'P2002', clientVersion: 'x' } as any,
    );
    prisma.planQuotaTemplate.create.mockRejectedValueOnce(p2002);
    await expect(
      service.create({ name: 'dup', rules: [validRule()] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ---------- list / get ----------

  it('list: applies search + isActive filters', async () => {
    prisma.planQuotaTemplate.findMany.mockResolvedValueOnce([]);
    prisma.planQuotaTemplate.count.mockResolvedValueOnce(0);
    await service.list({
      page: 2,
      pageSize: 5,
      search: 'high',
      isActive: true,
    });
    const args = prisma.planQuotaTemplate.findMany.mock.calls[0][0];
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.isActive).toBe(true);
    expect(args.where.OR).toBeDefined();
    expect(args.skip).toBe(5);
    expect(args.take).toBe(5);
  });

  it('list: corrupt rules JSON returns empty rules without throwing', async () => {
    prisma.planQuotaTemplate.findMany.mockResolvedValueOnce([
      {
        id: 't1',
        name: 'broken',
        description: '',
        rules: 'this is not json',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ]);
    prisma.planQuotaTemplate.count.mockResolvedValueOnce(1);
    const r = await service.list({ page: 1, pageSize: 20 });
    expect(r.items[0].rules).toEqual([]);
  });

  it('getById: throws on not found', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(service.getById('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ---------- update ----------

  it('update: rejects empty name', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({ id: 't1' });
    await expect(
      service.update('t1', { name: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update: rejects bad rules', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({ id: 't1' });
    await expect(
      service.update('t1', { rules: [validRule({ limitValue: 0 })] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update: applies partial fields', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({ id: 't1' });
    prisma.planQuotaTemplate.update.mockResolvedValueOnce({
      id: 't1',
      name: 'new',
      description: 'hi',
      rules: JSON.stringify([validRule()]),
      isActive: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    await service.update('t1', {
      name: 'new',
      description: 'hi',
      isActive: false,
    });
    const args = prisma.planQuotaTemplate.update.mock.calls[0][0];
    expect(args.data).toEqual({
      name: 'new',
      description: 'hi',
      isActive: false,
    });
  });

  it('update: rejects when new rules make a referenced plan exceed its monthlyCredits', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      rules: '[]',
      isActive: true,
      deletedAt: null,
    });
    // getReferencedPlanIdsByTemplateId → 该模板被 p1 引用
    prisma.planQuotaRule.findMany
      .mockResolvedValueOnce([{ templateId: 't1', planId: 'p1' }])
      // assertReferencedPlansConsistent 取各 plan 当前绑定（仅本模板）
      .mockResolvedValueOnce([
        { planId: 'p1', templateId: 't1', template: { rules: '[]', isActive: true, deletedAt: null } },
      ]);
    prisma.plan.findMany.mockResolvedValueOnce([
      { id: 'p1', name: 'PlanA', monthlyCredits: 1000, features: null, product: { billingMode: 'CODING_PLAN' } },
    ]);
    await expect(
      service.update('t1', {
        rules: [
          { windowType: 'ROLLING', metric: 'CREDITS', durationLabel: '5h', durationSec: 18000, limitValue: 1500 },
        ],
      }),
    ).rejects.toThrow(/不一致/);
    expect(prisma.planQuotaTemplate.update).not.toHaveBeenCalled();
  });

  it('update: 404 when soft-deleted or missing', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.update('nope', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update: maps unique violation to ConflictException', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({ id: 't1' });
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'unique violation',
      { code: 'P2002', clientVersion: 'x' } as any,
    );
    prisma.planQuotaTemplate.update.mockRejectedValueOnce(p2002);
    await expect(
      service.update('t1', { name: 'taken' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ---------- soft delete ----------

  it('softDelete: tombstones name and sets deletedAt + isActive=false', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      name: 'Premium',
    });
    prisma.planQuotaTemplate.update.mockResolvedValueOnce({});
    await service.softDelete('t1');
    const args = prisma.planQuotaTemplate.update.mock.calls[0][0];
    expect(args.data.deletedAt).toBeInstanceOf(Date);
    expect(args.data.isActive).toBe(false);
    expect(args.data.name).toMatch(/^Premium \(已删除 .+\)$/);
  });

  it('softDelete: 404 when missing', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(service.softDelete('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ---------- clone ----------

  it('clone: deep copies rules and uses "{name} 副本" suffix', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      name: 'Standard',
      description: 'desc',
      rules: JSON.stringify([validRule()]),
      isActive: true,
    });
    prisma.planQuotaTemplate.findUnique.mockResolvedValueOnce(null);
    prisma.planQuotaTemplate.create.mockResolvedValueOnce({
      id: 't2',
      name: 'Standard 副本',
      description: 'desc',
      rules: JSON.stringify([validRule()]),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    const r = await service.clone('t1');
    expect(r.name).toBe('Standard 副本');
    const args = prisma.planQuotaTemplate.create.mock.calls[0][0];
    expect(args.data.name).toBe('Standard 副本');
    expect(args.data.description).toBe('desc');
    expect(args.data.rules).toEqual(JSON.stringify([validRule()]));
  });

  it('clone: appends timestamp when "{name} 副本" already exists', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      name: 'Standard',
      description: '',
      rules: JSON.stringify([validRule()]),
      isActive: true,
    });
    // Simulate "Standard 副本" already existing
    prisma.planQuotaTemplate.findUnique.mockResolvedValueOnce({
      id: 'tx',
      name: 'Standard 副本',
    });
    prisma.planQuotaTemplate.create.mockResolvedValueOnce({
      id: 't3',
      name: 'Standard 副本 1714000000000',
      description: '',
      rules: JSON.stringify([validRule()]),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    await service.clone('t1');
    const args = prisma.planQuotaTemplate.create.mock.calls[0][0];
    expect(args.data.name).toMatch(/^Standard 副本 \d+$/);
  });

  it('clone: 404 when source missing', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(service.clone('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('clone: retries with timestamp suffix when create races on P2002', async () => {
    // Source exists, base name "{name} 副本" looks free, but a concurrent
    // clone wins the insert and we hit P2002 on our create. We must retry
    // with a timestamped name and succeed without bubbling a 500.
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      name: 'Standard',
      description: 'desc',
      rules: JSON.stringify([validRule()]),
      isActive: true,
    });
    prisma.planQuotaTemplate.findUnique.mockResolvedValueOnce(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'unique violation',
      { code: 'P2002', clientVersion: 'x' } as any,
    );
    prisma.planQuotaTemplate.create
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({
        id: 't9',
        name: 'Standard 副本 1714000000000',
        description: 'desc',
        rules: JSON.stringify([validRule()]),
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
    const r = await service.clone('t1');
    expect(r.id).toBe('t9');
    expect(prisma.planQuotaTemplate.create).toHaveBeenCalledTimes(2);
    const retryArgs = prisma.planQuotaTemplate.create.mock.calls[1][0];
    expect(retryArgs.data.name).toMatch(/^Standard 副本 \d+$/);
  });

  it('clone: rethrows non-P2002 errors without retry', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      name: 'Standard',
      description: '',
      rules: JSON.stringify([validRule()]),
      isActive: true,
    });
    prisma.planQuotaTemplate.findUnique.mockResolvedValueOnce(null);
    const boom = new Error('database is down');
    prisma.planQuotaTemplate.create.mockRejectedValueOnce(boom);
    await expect(service.clone('t1')).rejects.toBe(boom);
    expect(prisma.planQuotaTemplate.create).toHaveBeenCalledTimes(1);
  });

  // ---------- references ----------

  it('references: returns active plan bindings from PlanQuotaRule', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({
      id: 't1',
      name: 'x',
      description: '',
      rules: JSON.stringify([validRule()]),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    prisma.planQuotaRule.findMany
      .mockResolvedValueOnce([{ templateId: 't1', planId: 'plan-a' }])
      .mockResolvedValueOnce([
        { planId: 'plan-a' },
        { planId: 'plan-b' },
        { planId: 'plan-a' },
      ]);
    const r = await service.references('t1');
    expect(r).toEqual({ planIds: ['plan-a', 'plan-b'], count: 2 });
  });

  it('references: 404 when template missing', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(service.references('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('listPlanRules: returns bound templates with parsed rules', async () => {
    prisma.plan.findFirst.mockResolvedValueOnce({ id: 'plan-1' });
    prisma.planQuotaRule.findMany.mockResolvedValueOnce([
      {
        id: 'rule-1',
        planId: 'plan-1',
        templateId: 'tpl-1',
        isActive: true,
        createdAt: new Date('2026-06-01'),
        updatedAt: new Date('2026-06-01'),
        template: {
          id: 'tpl-1',
          name: '日限额',
          description: '每天最多 200 次',
          rules: JSON.stringify([validRule()]),
          isActive: true,
          createdAt: new Date('2026-06-01'),
          updatedAt: new Date('2026-06-01'),
          deletedAt: null,
        },
      },
    ]);

    const rules = await service.listPlanRules('plan-1');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      planId: 'plan-1',
      templateId: 'tpl-1',
      templateName: '日限额',
    });
    expect(rules[0].rules[0].metric).toBe('REQUESTS');
  });

  it('replacePlanRules: validates templates and replaces atomically', async () => {
    prisma.plan.findFirst
      .mockResolvedValueOnce({ id: 'plan-1' })
      .mockResolvedValueOnce({ id: 'plan-1' });
    // 两次 findMany：事务外预检 + 事务内(锁后)重校验模板启用(codex R2 P1-4)。
    prisma.planQuotaTemplate.findMany.mockResolvedValue([
      { id: 'tpl-1' },
      { id: 'tpl-2' },
    ]);
    prisma.planQuotaRule.findMany.mockResolvedValueOnce([]);

    await service.replacePlanRules('plan-1', ['tpl-1', 'tpl-2']);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.planQuotaRule.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan-1' } });
    expect(prisma.planQuotaRule.createMany).toHaveBeenCalledWith({
      data: [
        { planId: 'plan-1', templateId: 'tpl-1', isActive: true },
        { planId: 'plan-1', templateId: 'tpl-2', isActive: true },
      ],
    });
  });

  it('softDelete: 拒绝禁用被已上架自营套餐引用为唯一启用配额的模板(finding#13 守卫)', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({ id: 'tpl-1', name: 'Basic', deletedAt: null });
    prisma.planQuotaRule.findMany.mockResolvedValueOnce([{ planId: 'cp-1' }]);
    prisma.plan.findUnique.mockResolvedValueOnce({
      name: 'Raytone Pro',
      isActive: true,
      features: '[]',
      product: { billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package' },
    });
    prisma.planQuotaRule.count.mockResolvedValueOnce(0); // 排除本模板后剩 0 启用规则

    await expect(service.softDelete('tpl-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('softDelete: 放行(排除本模板后仍有其它启用规则 / 无已上架自营引用)', async () => {
    prisma.planQuotaTemplate.findFirst.mockResolvedValueOnce({ id: 'tpl-1', name: 'Basic', deletedAt: null });
    prisma.planQuotaRule.findMany.mockResolvedValueOnce([{ planId: 'cp-1' }]);
    prisma.plan.findUnique.mockResolvedValueOnce({
      name: 'Raytone Pro',
      isActive: true,
      features: '[]',
      product: { billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package' },
    });
    prisma.planQuotaRule.count.mockResolvedValueOnce(1); // 还有其它启用规则

    await expect(service.softDelete('tpl-1')).resolves.toBeUndefined();
  });

  it('replacePlanRules: rejects missing or inactive templates', async () => {
    prisma.plan.findFirst.mockResolvedValueOnce({ id: 'plan-1' });
    prisma.planQuotaTemplate.findMany.mockResolvedValueOnce([{ id: 'tpl-1' }]);

    await expect(
      service.replacePlanRules('plan-1', ['tpl-1', 'tpl-missing']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------- prisma stub factory ----------
function makePrismaStub() {
  const stub: any = {
    // finding #13：replacePlanRules 改为回调式事务 + per-plan advisory 锁(tx.$executeRaw)。
    // $transaction 收到函数则以 stub 自身为 tx 执行,故 planQuotaRule.deleteMany/createMany 断言不变。
    $executeRaw: jest.fn().mockResolvedValue(1),
    plan: {
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ name: 'test-plan', monthlyCredits: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    planQuotaTemplate: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    planQuotaRule: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  stub.$transaction = jest.fn(async (arg: any) =>
    typeof arg === 'function' ? arg(stub) : [],
  );
  return stub;
}
