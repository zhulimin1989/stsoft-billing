import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { CreditGrantExecutor } from './credit-grant-executor';
import { CreditGrantsController } from './credit-grants.controller';
import { CreditGrantsService } from './credit-grants.service';

describe('CreditGrantsController', () => {
  let controller: CreditGrantsController;
  let service: any;
  let executor: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      preview: jest.fn(),
      listRedemptions: jest.fn(),
    };
    executor = { executeRule: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CreditGrantsController],
      providers: [
        { provide: CreditGrantsService, useValue: service },
        { provide: CreditGrantExecutor, useValue: executor },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(CreditGrantsController);
  });

  it('full lifecycle: create → list → get → update → preview → trigger → redemptions → delete', async () => {
    // 1) create
    service.create.mockResolvedValueOnce({ id: 'r1' });
    const created = await controller.create({
      name: 'daily 100',
      triggerType: 'DAILY_CRON',
      cronExpr: '0 0 * * *',
      rewardType: 'CREDIT',
      rewardAmount: 100,
      expirePolicy: 'PERMANENT',
    });
    expect(created.code).toBe(0);
    expect((created.data as any).id).toBe('r1');

    // 2) list
    service.list.mockResolvedValueOnce({
      items: [{ id: 'r1' }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const list = await controller.list({ page: '1', pageSize: '20' });
    expect((list.data as any).items[0].id).toBe('r1');

    // 3) get
    service.getById.mockResolvedValueOnce({ id: 'r1' });
    const one = await controller.getOne('r1');
    expect((one.data as any).id).toBe('r1');

    // 4) update
    service.update.mockResolvedValueOnce({ id: 'r1', name: 'updated' });
    const upd = await controller.update('r1', { name: 'updated' });
    expect((upd.data as any).name).toBe('updated');

    // 5) preview
    service.preview.mockResolvedValueOnce({
      matchedCount: 5,
      estimatedTotalAmount: 500,
      sampleUserIds: ['u1'],
    });
    const prev = await controller.preview('r1');
    expect((prev.data as any).matchedCount).toBe(5);

    // 6) manual trigger (canonical path)
    service.getById.mockResolvedValueOnce({ id: 'r1' });
    executor.executeRule.mockResolvedValueOnce({
      ruleId: 'r1',
      attemptedUsers: 5,
      granted: 5,
      skippedPerUserLimit: 0,
      skippedCap: 0,
      failed: 0,
      totalAmount: 500,
    });
    const trig = await controller.manualTrigger('r1');
    expect((trig.data as any).granted).toBe(5);

    // 6b) `/trigger` alias used by current frontend
    service.getById.mockResolvedValueOnce({ id: 'r1' });
    executor.executeRule.mockResolvedValueOnce({
      ruleId: 'r1',
      attemptedUsers: 1,
      granted: 1,
      skippedPerUserLimit: 0,
      skippedCap: 0,
      failed: 0,
      totalAmount: 100,
    });
    const triAlias = await controller.triggerAlias('r1');
    expect((triAlias.data as any).granted).toBe(1);

    // 7) redemptions
    service.listRedemptions.mockResolvedValueOnce({
      items: [{ id: 'g1', userId: 'u1' }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const reds = await controller.listRedemptions('r1', {
      page: '1',
      pageSize: '20',
    });
    expect((reds.data as any).items[0].userId).toBe('u1');

    // 8) delete
    const del = await controller.remove('r1');
    expect(del.code).toBe(0);
    expect(service.softDelete).toHaveBeenCalledWith('r1');
  });

  it('create: rejects missing required fields', async () => {
    await expect(controller.create({ name: 'x' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      controller.create({
        name: 'x',
        triggerType: 'DAILY_CRON',
        rewardType: 'CREDIT',
        // missing rewardAmount
        expirePolicy: 'PERMANENT',
      }),
    ).rejects.toThrow(/rewardAmount/);
    await expect(
      controller.create({
        name: 'x',
        triggerType: 'DAILY_CRON',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        // missing expirePolicy
      }),
    ).rejects.toThrow(/expirePolicy/);
  });
});
