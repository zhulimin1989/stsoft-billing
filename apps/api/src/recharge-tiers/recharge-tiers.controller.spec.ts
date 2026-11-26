import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ADMIN_PERMISSION_KEY } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { RechargeTiersController } from './recharge-tiers.controller';
import { RechargeTiersService } from './recharge-tiers.service';

/**
 * Controller integration: full CRUD + clone lifecycle with the service mocked.
 * Asserts response envelope shape and the recharge-tier page read/manage split.
 */
describe('RechargeTiersController', () => {
  let controller: RechargeTiersController;
  let service: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      clone: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RechargeTiersController],
      providers: [{ provide: RechargeTiersService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(RechargeTiersController);
  });

  it('full lifecycle: create → list → get → update → clone → delete', async () => {
    // 1) create
    service.create.mockResolvedValueOnce({
      id: 't1',
      productId: 'p1',
      amountCents: 1000,
      bonusType: 'FIXED',
      bonusValue: 200,
      isActive: true,
    });
    const created = await controller.create({
      productId: 'p1',
      amountCents: 1000,
      bonusType: 'FIXED',
      bonusValue: 200,
    });
    expect(created).toEqual({
      code: 0,
      message: '创建成功',
      data: expect.objectContaining({ id: 't1' }),
    });

    // 2) list
    service.list.mockResolvedValueOnce({
      items: [{ id: 't1', amountCents: 1000 }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const list = await controller.list({ page: '1', pageSize: '20' });
    expect(list.code).toBe(0);
    expect((list.data as any).items[0].id).toBe('t1');

    // 3) get one
    service.getById.mockResolvedValueOnce({ id: 't1' });
    const one = await controller.getOne('t1');
    expect((one.data as any).id).toBe('t1');

    // 4) update
    service.update.mockResolvedValueOnce({ id: 't1', isActive: false });
    const upd = await controller.update('t1', { isActive: false });
    expect(upd).toEqual({
      code: 0,
      message: '更新成功',
      data: expect.objectContaining({ isActive: false }),
    });

    // 5) clone
    service.clone.mockResolvedValueOnce({ id: 't2', badge: '副本' });
    const cloned = await controller.clone('t1');
    expect(cloned).toEqual({
      code: 0,
      message: '已复制',
      data: expect.objectContaining({ id: 't2' }),
    });

    // 6) soft delete
    service.softDelete.mockResolvedValueOnce(undefined);
    const del = await controller.remove('t1');
    expect(del).toEqual({ code: 0, message: '删除成功', data: null });
  });

  it('create: rejects missing productId', async () => {
    await expect(
      controller.create({
        amountCents: 1000,
        bonusType: 'FIXED',
        bonusValue: 0,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects missing amountCents', async () => {
    await expect(
      controller.create({
        productId: 'p1',
        bonusType: 'FIXED',
        bonusValue: 0,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects missing bonusType', async () => {
    await expect(
      controller.create({
        productId: 'p1',
        amountCents: 1000,
        bonusValue: 0,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects missing bonusValue', async () => {
    await expect(
      controller.create({
        productId: 'p1',
        amountCents: 1000,
        bonusType: 'FIXED',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('list: parses isActive=true / isActive=false', async () => {
    service.list.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({ page: '1', pageSize: '20', isActive: 'true' });
    expect(service.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ isActive: true }),
    );
    await controller.list({ page: '1', pageSize: '20', isActive: 'false' });
    expect(service.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });

  it('list: ignores invalid pagination values and falls back', async () => {
    service.list.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({ page: 'oops', pageSize: 'NaN' });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it('list: forwards productId filter', async () => {
    service.list.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({
      page: '1',
      pageSize: '20',
      productId: '  p1  ',
    });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'p1' }),
    );
  });

  // Lock in the read/write permission split per PR2 convention. The admin
  // permission guard auto-grants .view to .manage holders, so this also
  // keeps existing manage users working on the read endpoints.
  it('decorators: endpoints use recharge-tier page permissions', () => {
    const permsOf = (method: string): string[] | undefined =>
      Reflect.getMetadata(
        ADMIN_PERMISSION_KEY,
        (RechargeTiersController.prototype as any)[method],
      );
    expect(permsOf('list')).toEqual(['admin.page.recharge_tiers.view']);
    expect(permsOf('getOne')).toEqual(['admin.page.recharge_tiers.view']);
    expect(permsOf('create')).toEqual(['admin.page.recharge_tiers.manage']);
    expect(permsOf('update')).toEqual(['admin.page.recharge_tiers.manage']);
    expect(permsOf('remove')).toEqual(['admin.page.recharge_tiers.manage']);
    expect(permsOf('clone')).toEqual(['admin.page.recharge_tiers.manage']);
  });
});
