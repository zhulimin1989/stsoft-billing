import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { UserSegmentsController } from './user-segments.controller';
import { UserSegmentsService } from './user-segments.service';

/**
 * Controller-level integration test: full create → add members → list →
 * delete flow with the service mocked. We assert response envelope shape and
 * that every endpoint dispatches to the service.
 */
describe('UserSegmentsController', () => {
  let controller: UserSegmentsController;
  let service: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      refresh: jest.fn(),
      preview: jest.fn(),
      listMembers: jest.fn(),
      addMembers: jest.fn(),
      removeMember: jest.fn(),
      references: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserSegmentsController],
      providers: [{ provide: UserSegmentsService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(UserSegmentsController);
  });

  it('full lifecycle: create → list → add members → list members → remove → delete', async () => {
    // 1) create
    service.create.mockResolvedValueOnce({
      id: 's1',
      name: 'VIP',
      ruleType: 'STATIC',
    });
    const created = await controller.create({
      name: 'VIP',
      ruleType: 'STATIC' as any,
    });
    expect(created).toEqual({
      code: 0,
      message: '创建成功',
      data: expect.objectContaining({ id: 's1' }),
    });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'VIP', ruleType: 'STATIC' }),
    );

    // 2) list
    service.list.mockResolvedValueOnce({
      items: [{ id: 's1', name: 'VIP' }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const list = await controller.list({ page: '1', pageSize: '20' });
    expect(list.code).toBe(0);
    expect((list.data as any).items[0].id).toBe('s1');

    // 3) add members
    service.addMembers.mockResolvedValueOnce({
      added: 2,
      skipped: 0,
      missing: [],
    });
    const addRes = await controller.addMembers('s1', {
      userIds: ['u1', 'u2'],
    });
    expect(addRes.code).toBe(0);
    expect(service.addMembers).toHaveBeenCalledWith('s1', ['u1', 'u2']);

    // 4) list members
    service.listMembers.mockResolvedValueOnce({
      items: [{ userId: 'u1', joinedAt: new Date(), user: null }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const members = await controller.listMembers('s1', {
      page: '1',
      pageSize: '20',
    });
    expect(members.code).toBe(0);
    expect((members.data as any).items.length).toBe(1);

    // 5) remove member
    service.removeMember.mockResolvedValueOnce(undefined);
    const rm = await controller.removeMember('s1', 'u1');
    expect(rm).toEqual({ code: 0, message: '已移除', data: null });

    // 6) soft delete
    service.softDelete.mockResolvedValueOnce(undefined);
    const del = await controller.remove('s1');
    expect(del).toEqual({ code: 0, message: '删除成功', data: null });
  });

  it('create: rejects missing name', async () => {
    await expect(
      controller.create({ ruleType: 'STATIC' as any } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: rejects missing ruleType', async () => {
    await expect(controller.create({ name: 'x' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('preview: dispatches to service', async () => {
    service.preview.mockResolvedValueOnce({
      matchedCount: 5,
      sampleUserIds: ['u1', 'u2'],
    });
    const r = await controller.preview({ ruleExpr: '{}' });
    expect(r.code).toBe(0);
    expect((r.data as any).matchedCount).toBe(5);
  });

  it('preview: rejects empty body', async () => {
    await expect(controller.preview({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refresh: dispatches to service', async () => {
    service.refresh.mockResolvedValueOnce({
      id: 's1',
      memberCount: 42,
    });
    const r = await controller.refresh('s1');
    expect(r.code).toBe(0);
    expect((r.data as any).memberCount).toBe(42);
  });

  it('addMembers: rejects non-array body', async () => {
    await expect(
      controller.addMembers('s1', {} as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('references: returns empty buckets', async () => {
    service.references.mockResolvedValueOnce({
      grantRules: [],
      campaigns: [],
      discountCodes: [],
    });
    const r = await controller.references('s1');
    expect(r.code).toBe(0);
    expect((r.data as any).grantRules).toEqual([]);
  });

  it('list: parses isActive=true and ruleType filter', async () => {
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
      isActive: 'true',
      ruleType: 'DYNAMIC',
    });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true, ruleType: 'DYNAMIC' }),
    );
  });
});
