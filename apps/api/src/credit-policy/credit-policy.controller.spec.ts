import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ADMIN_PERMISSION_KEY } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { CreditPolicyController } from './credit-policy.controller';
import { CreditPolicyService } from './credit-policy.service';

describe('CreditPolicyController', () => {
  let controller: CreditPolicyController;
  let service: any;

  beforeEach(async () => {
    service = {
      getGlobal: jest.fn(),
      upsertGlobal: jest.fn(),
      listSegments: jest.fn(),
      upsertSegment: jest.fn(),
      listOverdueUsers: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CreditPolicyController],
      providers: [{ provide: CreditPolicyService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(CreditPolicyController);
  });

  // ---------------- routing happy path ----------------

  it('GET /global wraps in ApiResponse envelope', async () => {
    service.getGlobal.mockResolvedValue({ id: 'cp1' });
    const out = await controller.getGlobal('p1');
    expect(out.code).toBe(0);
    expect((out.data as any).id).toBe('cp1');
    expect(service.getGlobal).toHaveBeenCalledWith('p1');
  });

  it('GET /global rejects empty productId', async () => {
    await expect(controller.getGlobal('')).rejects.toThrow(BadRequestException);
  });

  it('PUT /global passes productId + write input', async () => {
    service.upsertGlobal.mockResolvedValue({ id: 'cp1' });
    await controller.upsertGlobal({
      productId: 'p1',
      allowOverdraft: true,
      defaultCreditLimitCents: 5000,
    });
    expect(service.upsertGlobal).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ allowOverdraft: true, defaultCreditLimitCents: 5000 }),
    );
  });

  it('PUT /global rejects missing productId', async () => {
    await expect(controller.upsertGlobal({} as any)).rejects.toThrow(BadRequestException);
  });

  it('GET /segments returns list wrapped in items', async () => {
    service.listSegments.mockResolvedValue([{ id: 's1' }]);
    const out = await controller.listSegments('p1');
    expect((out.data as any).items[0].id).toBe('s1');
  });

  it('POST /segments rejects missing segmentId', async () => {
    await expect(
      controller.upsertSegment({ productId: 'p1' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('POST /segments calls service with productId+segmentId', async () => {
    service.upsertSegment.mockResolvedValue({ id: 'cp-seg' });
    await controller.upsertSegment({
      productId: 'p1',
      segmentId: 'seg-vip',
      allowOverdraft: true,
    });
    expect(service.upsertSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'p1',
        segmentId: 'seg-vip',
        data: expect.objectContaining({ allowOverdraft: true }),
      }),
    );
  });

  it('GET /overdue-users parses pagination', async () => {
    service.listOverdueUsers.mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      pageSize: 50,
    });
    await controller.listOverdueUsers({ productId: 'p1', page: '2', pageSize: '50' });
    expect(service.listOverdueUsers).toHaveBeenCalledWith({
      productId: 'p1',
      page: 2,
      pageSize: 50,
    });
  });

  it('GET /overdue-users defaults page=1 pageSize=20', async () => {
    service.listOverdueUsers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    await controller.listOverdueUsers({});
    expect(service.listOverdueUsers).toHaveBeenCalledWith({
      productId: undefined,
      page: 1,
      pageSize: 20,
    });
  });

  // ---------------- permission metadata ----------------

  describe('permission metadata', () => {
    const reflector = new Reflector();

    it.each([
      ['getGlobal', 'admin.page.credit_policy.view'],
      ['upsertGlobal', 'admin.page.credit_policy.manage'],
      ['listSegments', 'admin.page.credit_policy.view'],
      ['upsertSegment', 'admin.page.credit_policy.manage'],
      ['listOverdueUsers', 'admin.page.credit_policy.view'],
    ])('%s requires permission %s', (methodName, perm) => {
      const handler = (CreditPolicyController.prototype as any)[methodName];
      const meta = reflector.get<string[]>(ADMIN_PERMISSION_KEY, handler);
      expect(meta).toEqual([perm]);
    });
  });
});
