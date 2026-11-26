import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ADMIN_PERMISSION_KEY } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { AlertEventsController } from './alert-events.controller';
import { AlertEventService } from './alert-events.service';

describe('AlertEventsController', () => {
  let controller: AlertEventsController;
  let service: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      getStats: jest.fn(),
      markRead: jest.fn(),
      handle: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AlertEventsController],
      providers: [{ provide: AlertEventService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AlertEventsController);
  });

  // -------------------- happy path --------------------

  it('list: parses query + returns ApiResponse envelope', async () => {
    service.list.mockResolvedValueOnce({
      items: [{ id: 'a1' }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const out = await controller.list({
      page: '1',
      pageSize: '20',
      category: 'PAYMENT',
      severity: 'HIGH',
      status: 'PENDING',
      userId: ' u1 ',
      q: 'foo',
    });
    expect(out.code).toBe(0);
    expect((out.data as any).items[0].id).toBe('a1');
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 20,
        category: 'PAYMENT',
        severity: 'HIGH',
        status: 'PENDING',
        userId: 'u1',
        q: 'foo',
      }),
    );
  });

  it('list: invalid enum values are dropped (ignored), not 400', async () => {
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
      category: 'BOGUS',
      severity: 'NOPE',
    });
    const args = service.list.mock.calls[0][0];
    expect(args.category).toBeUndefined();
    expect(args.severity).toBeUndefined();
  });

  it('list: accepts `search` alias for q (frontend stub uses search)', async () => {
    service.list.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({ search: 'hello' });
    expect(service.list.mock.calls[0][0].q).toBe('hello');
  });

  it('stats: returns three counts', async () => {
    service.getStats.mockResolvedValueOnce({
      unreadCount: 7,
      criticalCount: 2,
      todayCount: 12,
    });
    const out = await controller.stats();
    expect(out.data).toEqual({ unreadCount: 7, criticalCount: 2, todayCount: 12 });
  });

  it('getOne: returns alert by id', async () => {
    service.getById.mockResolvedValueOnce({ id: 'a1', status: 'PENDING' });
    const out = await controller.getOne('a1');
    expect((out.data as any).id).toBe('a1');
    expect(service.getById).toHaveBeenCalledWith('a1');
  });

  it('markRead: passes ids + adminId; returns updated count', async () => {
    service.markRead.mockResolvedValueOnce({ updated: 2 });
    const out = await controller.markRead('admin1', { ids: ['a1', 'a2'] });
    expect((out.data as any).updated).toBe(2);
    expect(service.markRead).toHaveBeenCalledWith(['a1', 'a2'], 'admin1');
  });

  it('markRead: rejects empty / missing ids with 400', async () => {
    await expect(
      controller.markRead('admin1', { ids: [] }),
    ).rejects.toThrow(BadRequestException);
    await expect(controller.markRead('admin1', {})).rejects.toThrow(
      BadRequestException,
    );
  });

  it('handle: trims note + passes through; returns ok', async () => {
    service.handle.mockResolvedValueOnce({ id: 'a1', status: 'HANDLED' });
    const out = await controller.handle('admin1', 'a1', { note: '  fixed  ' });
    expect((out.data as any).status).toBe('HANDLED');
    expect(service.handle).toHaveBeenCalledWith('a1', 'admin1', 'fixed');
  });

  it('handle: rejects empty note with 400', async () => {
    await expect(
      controller.handle('admin1', 'a1', { note: '   ' }),
    ).rejects.toThrow(BadRequestException);
    await expect(controller.handle('admin1', 'a1', {})).rejects.toThrow(
      BadRequestException,
    );
    expect(service.handle).not.toHaveBeenCalled();
  });

  // -------------------- 权限元数据 --------------------

  it('decorators: endpoints use alert page permissions', () => {
    const permsOf = (method: string): string[] | undefined =>
      Reflect.getMetadata(
        ADMIN_PERMISSION_KEY,
        (AlertEventsController.prototype as any)[method],
      );
    expect(permsOf('list')).toEqual(['admin.page.alerts.view']);
    expect(permsOf('stats')).toEqual(['admin.page.alerts.view']);
    expect(permsOf('getOne')).toEqual(['admin.page.alerts.view']);
    expect(permsOf('markRead')).toEqual(['admin.page.alerts.manage']);
    expect(permsOf('handle')).toEqual(['admin.page.alerts.manage']);
  });
});
