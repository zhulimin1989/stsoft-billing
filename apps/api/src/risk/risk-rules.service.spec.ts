import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RiskRulesService } from './risk-rules.service';

describe('RiskRulesService', () => {
  let service: RiskRulesService;
  let prisma: any;

  const baseRule = (overrides: Record<string, unknown> = {}) => ({
    id: 'r1',
    name: 'rule',
    ruleType: 'BLACKLIST',
    config: JSON.stringify({ matchTypes: ['EMAIL'] }),
    action: 'ALERT',
    isActive: true,
    triggerCount: 0,
    lastTriggeredAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      riskRule: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      riskList: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    };
    const m = await Test.createTestingModule({
      providers: [
        RiskRulesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = m.get(RiskRulesService);
  });

  // ---------------- create validation ----------------

  it('create: BLACKLIST happy path normalizes matchTypes', async () => {
    prisma.riskRule.create.mockResolvedValueOnce(
      baseRule({ config: JSON.stringify({ matchTypes: ['EMAIL', 'IP'] }) }),
    );
    const result = await service.create({
      name: 'rule',
      ruleType: 'BLACKLIST',
      action: 'BLOCK',
      config: { matchTypes: ['EMAIL', 'IP'] },
    });
    expect(result.config).toEqual({ matchTypes: ['EMAIL', 'IP'] });
    expect(prisma.riskRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleType: 'BLACKLIST',
        action: 'BLOCK',
      }),
    });
  });

  it('create: BLACKLIST with invalid matchTypes is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'BLACKLIST',
        action: 'ALERT',
        config: { matchTypes: ['ZZZ'] },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('create: BLACKLIST with empty matchTypes is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'BLACKLIST',
        action: 'ALERT',
        config: { matchTypes: [] },
      }),
    ).rejects.toThrow(/matchTypes/);
  });

  it('create: USAGE_THRESHOLD validates metric / threshold / windowSec', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'USAGE_THRESHOLD',
        action: 'ALERT',
        config: { metric: 'BAD', threshold: 100, windowSec: 3600 },
      }),
    ).rejects.toThrow(/metric/);

    await expect(
      service.create({
        name: 'r',
        ruleType: 'USAGE_THRESHOLD',
        action: 'ALERT',
        config: { metric: 'DAILY_TOKEN', threshold: -1, windowSec: 3600 },
      }),
    ).rejects.toThrow(/threshold/);

    await expect(
      service.create({
        name: 'r',
        ruleType: 'USAGE_THRESHOLD',
        action: 'ALERT',
        config: { metric: 'DAILY_TOKEN', threshold: 100, windowSec: 1 },
      }),
    ).rejects.toThrow(/windowSec/);

    prisma.riskRule.create.mockResolvedValueOnce(
      baseRule({
        ruleType: 'USAGE_THRESHOLD',
        config: JSON.stringify({
          metric: 'DAILY_TOKEN',
          threshold: 1000000,
          windowSec: 86400,
        }),
      }),
    );
    const ok = await service.create({
      name: 'r',
      ruleType: 'USAGE_THRESHOLD',
      action: 'ALERT',
      config: { metric: 'DAILY_TOKEN', threshold: 1000000, windowSec: 86400 },
    });
    expect((ok.config as any).metric).toBe('DAILY_TOKEN');
  });

  it('create: IP_LIMIT validates windowDays / maxAccountsPerIp', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'IP_LIMIT',
        action: 'ALERT',
        config: { windowDays: 100, maxAccountsPerIp: 5 },
      }),
    ).rejects.toThrow(/windowDays/);

    await expect(
      service.create({
        name: 'r',
        ruleType: 'IP_LIMIT',
        action: 'ALERT',
        config: { windowDays: 7, maxAccountsPerIp: 1 },
      }),
    ).rejects.toThrow(/maxAccountsPerIp/);
  });

  it('create: REFUND_RATE validates scope / thresholdPct / windowDays', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'REFUND_RATE',
        action: 'ALERT',
        config: { scope: 'BAD', thresholdPct: 10, windowDays: 30 },
      }),
    ).rejects.toThrow(/scope/);

    await expect(
      service.create({
        name: 'r',
        ruleType: 'REFUND_RATE',
        action: 'ALERT',
        config: { scope: 'GLOBAL', thresholdPct: 0, windowDays: 30 },
      }),
    ).rejects.toThrow(/thresholdPct/);

    await expect(
      service.create({
        name: 'r',
        ruleType: 'REFUND_RATE',
        action: 'ALERT',
        config: { scope: 'GLOBAL', thresholdPct: 200, windowDays: 30 },
      }),
    ).rejects.toThrow(/thresholdPct/);
  });

  it('create: REFUND_RATE PRODUCT scope rejected (not yet implemented)', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'REFUND_RATE',
        action: 'ALERT',
        config: { scope: 'PRODUCT', thresholdPct: 10, windowDays: 30 },
      }),
    ).rejects.toThrow(/PRODUCT/);
  });

  it('create: BLACKLIST + BLOCK emits a top-level WARN log', async () => {
    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    prisma.riskRule.create.mockResolvedValueOnce(
      baseRule({ id: 'r1', action: 'BLOCK' }),
    );
    await service.create({
      name: 'rule',
      ruleType: 'BLACKLIST',
      action: 'BLOCK',
      config: { matchTypes: ['EMAIL'] },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/BLACKLIST BLOCK rule created/),
    );
    warnSpy.mockRestore();
  });

  it('create: FRAUD_PROVIDER requires provider name', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'FRAUD_PROVIDER',
        action: 'ALERT',
        config: { provider: '   ' },
      }),
    ).rejects.toThrow(/provider/);
  });

  it('create: empty name rejected', async () => {
    await expect(
      service.create({
        name: '   ',
        ruleType: 'BLACKLIST',
        action: 'ALERT',
        config: { matchTypes: ['EMAIL'] },
      }),
    ).rejects.toThrow(/name/);
  });

  it('create: invalid action rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        ruleType: 'BLACKLIST',
        action: 'BAD' as any,
        config: { matchTypes: ['EMAIL'] },
      }),
    ).rejects.toThrow(/action/);
  });

  // ---------------- get / update ----------------

  it('getById: throws NotFoundException when missing', async () => {
    prisma.riskRule.findFirst.mockResolvedValueOnce(null);
    await expect(service.getById('missing')).rejects.toThrow(NotFoundException);
  });

  it('update: re-validates config when ruleType changes', async () => {
    prisma.riskRule.findFirst.mockResolvedValueOnce(baseRule());
    prisma.riskRule.update.mockResolvedValueOnce(
      baseRule({
        ruleType: 'IP_LIMIT',
        config: JSON.stringify({ windowDays: 7, maxAccountsPerIp: 5 }),
      }),
    );
    const updated = await service.update('r1', {
      ruleType: 'IP_LIMIT',
      config: { windowDays: 7, maxAccountsPerIp: 5 },
    });
    expect((updated.config as any).maxAccountsPerIp).toBe(5);
  });

  it('softDelete: marks deleted_at and isActive=false', async () => {
    prisma.riskRule.findFirst.mockResolvedValueOnce(baseRule());
    prisma.riskRule.update.mockResolvedValueOnce(undefined);
    await service.softDelete('r1');
    expect(prisma.riskRule.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ isActive: false }),
    });
  });

  // ---------------- RiskList ----------------

  it('addEntry: rejects malformed EMAIL', async () => {
    await expect(
      service.addEntry({
        listType: 'EMAIL',
        value: 'not-an-email',
        addedBy: 'admin1',
      }),
    ).rejects.toThrow(/EMAIL/);
  });

  it('addEntry: happy path persists', async () => {
    prisma.riskList.create.mockResolvedValueOnce({
      id: 'l1',
      listType: 'EMAIL',
      value: 'spam@evil.com',
    });
    const out = await service.addEntry({
      listType: 'EMAIL',
      value: 'spam@evil.com',
      reason: 'reported',
      addedBy: 'admin1',
    });
    expect(out.id).toBe('l1');
  });

  it('addEntry: surfaces P2002 unique constraint as 400', async () => {
    const err: any = new Error('unique');
    err.code = 'P2002';
    Object.setPrototypeOf(err, require('@prisma/client').Prisma.PrismaClientKnownRequestError.prototype);
    prisma.riskList.create.mockRejectedValueOnce(err);
    await expect(
      service.addEntry({
        listType: 'EMAIL',
        value: 'spam@evil.com',
        addedBy: 'admin1',
      }),
    ).rejects.toThrow(/已存在/);
  });

  it('removeEntry: NotFound when missing', async () => {
    prisma.riskList.findUnique.mockResolvedValueOnce(null);
    await expect(service.removeEntry('missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});
