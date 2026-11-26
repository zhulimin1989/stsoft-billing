import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ADMIN_PERMISSION_KEY } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { QuotaTemplatesController } from './quota-templates.controller';
import { QuotaTemplatesService } from './quota-templates.service';

/**
 * Controller integration: full CRUD + clone + references lifecycle with the
 * service mocked. Asserts response envelope shape and that every endpoint
 * dispatches to the service.
 */
describe('QuotaTemplatesController', () => {
  let controller: QuotaTemplatesController;
  let service: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      clone: jest.fn(),
      references: jest.fn(),
      listPlanRules: jest.fn(),
      replacePlanRules: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [QuotaTemplatesController],
      providers: [{ provide: QuotaTemplatesService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(QuotaTemplatesController);
  });

  it('full lifecycle: create → list → get → update → clone → references → delete', async () => {
    // 1) create
    service.create.mockResolvedValueOnce({
      id: 't1',
      name: 'High',
      description: '',
      rules: [],
      referencedPlanIds: [],
      isActive: true,
    });
    const created = await controller.create({
      name: 'High',
      rules: [
        {
          windowType: 'ROLLING',
          durationLabel: '5h',
          durationSec: 18000,
          metric: 'REQUESTS',
          limitValue: 200,
        },
      ],
    });
    expect(created).toEqual({
      code: 0,
      message: '创建成功',
      data: expect.objectContaining({ id: 't1' }),
    });

    // 2) list
    service.list.mockResolvedValueOnce({
      items: [{ id: 't1', name: 'High' }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const list = await controller.list({ page: '1', pageSize: '20' });
    expect(list.code).toBe(0);
    expect((list.data as any).items[0].id).toBe('t1');

    // 3) get one
    service.getById.mockResolvedValueOnce({ id: 't1', name: 'High' });
    const one = await controller.getOne('t1');
    expect((one.data as any).id).toBe('t1');

    // 4) update
    service.update.mockResolvedValueOnce({ id: 't1', name: 'HighUpdated' });
    const upd = await controller.update('t1', { name: 'HighUpdated' });
    expect(upd).toEqual({
      code: 0,
      message: '更新成功',
      data: expect.objectContaining({ name: 'HighUpdated' }),
    });

    // 5) clone
    service.clone.mockResolvedValueOnce({ id: 't2', name: 'High 副本' });
    const cloned = await controller.clone('t1');
    expect(cloned).toEqual({
      code: 0,
      message: '已复制',
      data: expect.objectContaining({ id: 't2' }),
    });

    // 6) plan rule binding
    service.listPlanRules.mockResolvedValueOnce([{ id: 'r1', planId: 'plan-1' }]);
    const planRules = await controller.listPlanRules('plan-1');
    expect((planRules.data as any)[0].id).toBe('r1');

    service.replacePlanRules.mockResolvedValueOnce([{ id: 'r2', planId: 'plan-1' }]);
    const savedRules = await controller.replacePlanRules('plan-1', {
      templateIds: ['t1'],
    });
    expect(savedRules.message).toBe('保存成功');
    expect(service.replacePlanRules).toHaveBeenCalledWith('plan-1', ['t1']);

    // 7) references
    service.references.mockResolvedValueOnce({ planIds: [], count: 0 });
    const refs = await controller.references('t1');
    expect((refs.data as any).count).toBe(0);

    // 8) soft delete
    service.softDelete.mockResolvedValueOnce(undefined);
    const del = await controller.remove('t1');
    expect(del).toEqual({ code: 0, message: '删除成功', data: null });
  });

  it('create: rejects missing name', async () => {
    await expect(
      controller.create({ rules: [] } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects missing rules', async () => {
    await expect(
      controller.create({ name: 'x' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('list: parses isActive=true filter', async () => {
    service.list.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({ page: '1', pageSize: '20', isActive: 'true' });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true }),
    );
  });

  it('list: parses isActive=false filter', async () => {
    service.list.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({ page: '1', pageSize: '20', isActive: 'false' });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });

  // Lock in the read/write permission split: read endpoints accept .view,
  // mutations require .manage. Admin guard auto-grants .view to .manage holders,
  // so this also keeps existing manage users working.
  it('decorators: endpoints use quota-template page permissions', () => {
    const permsOf = (method: string): string[] | undefined =>
      Reflect.getMetadata(
        ADMIN_PERMISSION_KEY,
        (QuotaTemplatesController.prototype as any)[method],
      );
    expect(permsOf('list')).toEqual(['admin.page.coding_quota_templates.view']);
    expect(permsOf('getOne')).toEqual(['admin.page.coding_quota_templates.view']);
    expect(permsOf('listPlanRules')).toEqual(['admin.page.coding_quota_templates.view']);
    expect(permsOf('references')).toEqual(['admin.page.coding_quota_templates.view']);
    expect(permsOf('create')).toEqual(['admin.page.coding_quota_templates.manage']);
    expect(permsOf('update')).toEqual(['admin.page.coding_quota_templates.manage']);
    expect(permsOf('replacePlanRules')).toEqual(['admin.page.coding_quota_templates.manage']);
    expect(permsOf('remove')).toEqual(['admin.page.coding_quota_templates.manage']);
    expect(permsOf('clone')).toEqual(['admin.page.coding_quota_templates.manage']);
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
});
