import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { RiskFlagsController } from './risk-flags.controller';
import { RiskFlagsService } from './risk-flags.service';
import { RiskRulesController } from './risk-rules.controller';
import { RiskRulesService } from './risk-rules.service';

describe('RiskRulesController', () => {
  let controller: RiskRulesController;
  let service: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      listEntries: jest.fn(),
      addEntry: jest.fn(),
      removeEntry: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RiskRulesController],
      providers: [{ provide: RiskRulesService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(RiskRulesController);
  });

  it('full RiskRule lifecycle: create → list → get → update → delete', async () => {
    service.create.mockResolvedValueOnce({ id: 'r1', config: { matchTypes: ['EMAIL'] } });
    const created = await controller.create({
      name: 'rule',
      ruleType: 'BLACKLIST',
      action: 'BLOCK',
      config: { matchTypes: ['EMAIL'] },
      confirmDangerousAction: true,
    });
    expect(created.code).toBe(0);

    service.list.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0 });
    const list = await controller.list({});
    expect((list.data as any).items).toEqual([]);

    service.getById.mockResolvedValueOnce({ id: 'r1' });
    const one = await controller.getOne('r1');
    expect((one.data as any).id).toBe('r1');

    service.update.mockResolvedValueOnce({ id: 'r1', isActive: false });
    const upd = await controller.update('r1', { isActive: false });
    expect((upd.data as any).isActive).toBe(false);

    const del = await controller.remove('r1');
    expect(del.code).toBe(0);
    expect(service.softDelete).toHaveBeenCalledWith('r1');
  });

  it('create: rejects missing required fields', async () => {
    await expect(controller.create({})).rejects.toThrow(BadRequestException);
    await expect(
      controller.create({ name: 'r' }),
    ).rejects.toThrow(/ruleType/);
    // action is now optional and defaults to ALERT — missing config is the
    // next failure mode.
    await expect(
      controller.create({ name: 'r', ruleType: 'BLACKLIST' }),
    ).rejects.toThrow(/config/);
    await expect(
      controller.create({ name: 'r', ruleType: 'BLACKLIST', action: 'ALERT' }),
    ).rejects.toThrow(/config/);
  });

  it('create: action defaults to ALERT when omitted', async () => {
    service.create.mockResolvedValueOnce({ id: 'r1' });
    await controller.create({
      name: 'rule',
      ruleType: 'USAGE_THRESHOLD',
      config: { metric: 'DAILY_TOKEN', threshold: 100, windowSec: 3600 },
    });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ALERT' }),
    );
  });

  it('create: dangerous actions require confirmDangerousAction:true', async () => {
    for (const action of ['BLOCK', 'FREEZE_USER', 'DISABLE_KEY'] as const) {
      await expect(
        controller.create({
          name: 'rule',
          ruleType: 'BLACKLIST',
          action,
          config: { matchTypes: ['EMAIL'] },
        }),
      ).rejects.toThrow(/confirmDangerousAction/);
    }

    service.create.mockResolvedValueOnce({ id: 'r1' });
    const ok = await controller.create({
      name: 'rule',
      ruleType: 'BLACKLIST',
      action: 'BLOCK',
      config: { matchTypes: ['EMAIL'] },
      confirmDangerousAction: true,
    });
    expect(ok.code).toBe(0);
  });

  it('update: dangerous action requires confirmDangerousAction:true', async () => {
    await expect(
      controller.update('r1', { action: 'BLOCK' }),
    ).rejects.toThrow(/confirmDangerousAction/);
    service.update.mockResolvedValueOnce({ id: 'r1' });
    const ok = await controller.update('r1', {
      action: 'BLOCK',
      confirmDangerousAction: true,
    });
    expect(ok.code).toBe(0);
  });

  it('list-entries: list / add / remove flow', async () => {
    service.listEntries.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0 });
    await controller.listEntries({});
    expect(service.listEntries).toHaveBeenCalled();

    service.addEntry.mockResolvedValueOnce({ id: 'l1' });
    await controller.addEntry('admin1', {
      listType: 'EMAIL',
      value: 'spam@evil.com',
      reason: 'r',
    });
    expect(service.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ addedBy: 'admin1', listType: 'EMAIL' }),
    );

    await controller.removeEntry('l1');
    expect(service.removeEntry).toHaveBeenCalledWith('l1');
  });

  it('addEntry: rejects missing listType / value', async () => {
    await expect(
      controller.addEntry('admin1', {} as any),
    ).rejects.toThrow(/listType/);
    await expect(
      controller.addEntry('admin1', { listType: 'EMAIL' } as any),
    ).rejects.toThrow(/value/);
  });
});

describe('RiskFlagsController', () => {
  let controller: RiskFlagsController;
  let service: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      release: jest.fn(),
      permanentBan: jest.fn(),
      related: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RiskFlagsController],
      providers: [{ provide: RiskFlagsService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(RiskFlagsController);
  });

  it('list: forwards filters', async () => {
    service.list.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
    await controller.list({
      page: '2',
      pageSize: '10',
      ruleType: 'IP_LIMIT',
      severity: 'HIGH',
      status: 'PENDING',
    });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        pageSize: 10,
        ruleType: 'IP_LIMIT',
        severity: 'HIGH',
        status: 'PENDING',
      }),
    );
  });

  it('release: requires note', async () => {
    await expect(
      controller.release('admin1', 'f1', { note: '' }),
    ).rejects.toThrow(/note/);
    service.release.mockResolvedValueOnce({ id: 'f1' });
    const r = await controller.release('admin1', 'f1', { note: 'manual' });
    expect((r.data as any).id).toBe('f1');
  });

  it('ban: requires reason', async () => {
    await expect(
      controller.ban('admin1', 'f1', { reason: '' }),
    ).rejects.toThrow(/reason/);
    service.permanentBan.mockResolvedValueOnce({ id: 'f1' });
    const r = await controller.ban('admin1', 'f1', { reason: 'fraud' });
    expect((r.data as any).id).toBe('f1');
  });

  it('related: returns mode + items', async () => {
    service.related.mockResolvedValueOnce({ mode: 'IP', items: [{ userId: 'u2' }] });
    const r = await controller.related('f1');
    expect((r.data as any).mode).toBe('IP');
  });
});
