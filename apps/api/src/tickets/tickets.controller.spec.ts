import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { TicketsController } from './tickets.controller';
import { TicketsUserController } from './tickets-user.controller';
import { TicketsService } from './tickets.service';

describe('TicketsController (admin)', () => {
  let controller: TicketsController;
  let service: any;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      create: jest.fn(),
      getDetail: jest.fn(),
      addMessage: jest.fn(),
      changeStatus: jest.fn(),
      assign: jest.fn(),
      changeCategory: jest.fn(),
      changePriority: jest.fn(),
      close: jest.fn(),
      merge: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketsController],
      providers: [{ provide: TicketsService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(TicketsController);
  });

  it('list: forwards filters', async () => {
    service.list.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({
      page: '2',
      pageSize: '10',
      category: 'BILLING',
      priority: 'HIGH',
      status: 'OPEN',
      assigneeId: 'admin2',
      userId: 'u1',
    });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        pageSize: 10,
        category: 'BILLING',
        priority: 'HIGH',
        status: 'OPEN',
        assigneeId: 'admin2',
        userId: 'u1',
      }),
    );
  });

  it('list: drops invalid enum values silently', async () => {
    service.list.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list({ category: 'BAD', priority: 'BAD', status: 'BAD' });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        category: undefined,
        priority: undefined,
        status: undefined,
      }),
    );
  });

  it('create: rejects missing fields', async () => {
    await expect(controller.create('admin1', {})).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      controller.create('admin1', { userId: 'u1' }),
    ).rejects.toThrow(/subject/);
    await expect(
      controller.create('admin1', { userId: 'u1', subject: 's' }),
    ).rejects.toThrow(/category/);
    await expect(
      controller.create('admin1', {
        userId: 'u1',
        subject: 's',
        category: 'BAD' as any,
      }),
    ).rejects.toThrow(/category/);
  });

  it('create: passes asAdminId', async () => {
    service.create.mockResolvedValueOnce({ id: 't1' });
    await controller.create('admin1', {
      userId: 'u1',
      subject: 'help',
      category: 'BILLING',
      content: 'detail',
    });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        asAdminId: 'admin1',
        initialContent: 'detail',
      }),
    );
  });

  it('reply: rejects missing content', async () => {
    await expect(
      controller.reply('admin1', 't1', {}),
    ).rejects.toThrow(/content/);
  });

  it('reply: forwards isInternal flag', async () => {
    service.addMessage.mockResolvedValueOnce({ id: 'm1' });
    await controller.reply('admin1', 't1', {
      content: 'note',
      isInternal: true,
    });
    expect(service.addMessage).toHaveBeenCalledWith('t1', {
      authorType: 'ADMIN',
      authorId: 'admin1',
      content: 'note',
      isInternal: true,
      attachments: undefined,
    });
  });

  it('changeStatus: validates enum', async () => {
    await expect(
      controller.changeStatus('admin1', 't1', { status: 'BAD' as any }),
    ).rejects.toThrow(/status/);
    service.changeStatus.mockResolvedValueOnce({ id: 't1', status: 'CLOSED' });
    const r = await controller.changeStatus('admin1', 't1', { status: 'CLOSED' });
    expect(service.changeStatus).toHaveBeenCalledWith('t1', 'CLOSED', 'admin1');
    expect((r.data as any).status).toBe('CLOSED');
  });

  it('assign: passes null for unassign', async () => {
    service.assign.mockResolvedValueOnce({ id: 't1', assigneeId: null });
    await controller.assign('admin1', 't1', { assigneeId: null });
    expect(service.assign).toHaveBeenCalledWith('t1', null, 'admin1');
  });

  it('changeCategory / changePriority: validate enums', async () => {
    await expect(
      controller.changeCategory('admin1', 't1', { category: 'BAD' as any }),
    ).rejects.toThrow(/category/);
    await expect(
      controller.changePriority('admin1', 't1', { priority: 'BAD' as any }),
    ).rejects.toThrow(/priority/);
  });

  it('close: forwards', async () => {
    service.close.mockResolvedValueOnce({ id: 't1', status: 'CLOSED' });
    await controller.close('admin1', 't1');
    expect(service.close).toHaveBeenCalledWith('t1', 'admin1');
  });

  it('merge: requires targetId', async () => {
    await expect(
      controller.merge('admin1', 't1', {}),
    ).rejects.toThrow(/targetId/);
    service.merge.mockResolvedValueOnce({ src: { id: 't1' }, dst: { id: 't2' } });
    const r = await controller.merge('admin1', 't1', { targetId: 't2' });
    expect(service.merge).toHaveBeenCalledWith('t1', 't2', 'admin1');
    expect((r.data as any).dst.id).toBe('t2');
  });

  it('detail: routes to service', async () => {
    service.getDetail.mockResolvedValueOnce({ ticket: { id: 't1' }, messages: [], user: null });
    const r = await controller.detail('t1');
    expect(service.getDetail).toHaveBeenCalledWith('t1', { includeInternal: true });
    expect(r.code).toBe(0);
  });
});

describe('TicketsUserController', () => {
  let controller: TicketsUserController;
  let service: any;

  beforeEach(async () => {
    service = {
      listForUser: jest.fn(),
      createForUser: jest.fn(),
      getDetailForUser: jest.fn(),
      replyForUser: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketsUserController],
      providers: [{ provide: TicketsService, useValue: service }],
    }).compile();
    controller = module.get(TicketsUserController);
  });

  it('list: rejects unauthenticated', async () => {
    await expect(
      controller.list('', { page: '1' }),
    ).rejects.toThrow(/未登录/);
  });

  it('list: forwards userId + status', async () => {
    service.listForUser.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list('u1', { status: 'OPEN', page: '1' });
    expect(service.listForUser).toHaveBeenCalledWith('u1', 1, 20, 'OPEN');
  });

  it('list: drops invalid status enum', async () => {
    service.listForUser.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.list('u1', { status: 'BAD' });
    expect(service.listForUser).toHaveBeenCalledWith('u1', 1, 20, undefined);
  });

  it('create: validates fields', async () => {
    await expect(controller.create('', {})).rejects.toThrow(/未登录/);
    await expect(controller.create('u1', {})).rejects.toThrow(/subject/);
    await expect(
      controller.create('u1', { subject: 's' }),
    ).rejects.toThrow(/category/);
    await expect(
      controller.create('u1', { subject: 's', category: 'BAD' as any }),
    ).rejects.toThrow(/category/);
  });

  it('create: routes to service.createForUser', async () => {
    service.createForUser.mockResolvedValueOnce({ id: 't1' });
    await controller.create('u1', {
      subject: 'help',
      category: 'BILLING',
      content: 'I need help',
    });
    expect(service.createForUser).toHaveBeenCalledWith('u1', {
      subject: 'help',
      category: 'BILLING',
      priority: undefined,
      content: 'I need help',
    });
  });

  it('detail: routes to getDetailForUser (filters internal)', async () => {
    service.getDetailForUser.mockResolvedValueOnce({
      ticket: { id: 't1' },
      messages: [],
      user: null,
    });
    await controller.detail('u1', 't1');
    expect(service.getDetailForUser).toHaveBeenCalledWith('t1', 'u1');
  });

  it('reply: requires content', async () => {
    await expect(controller.reply('u1', 't1', {})).rejects.toThrow(/content/);
  });

  it('reply: routes to replyForUser', async () => {
    service.replyForUser.mockResolvedValueOnce({ id: 'm1' });
    await controller.reply('u1', 't1', { content: 'thx' });
    expect(service.replyForUser).toHaveBeenCalledWith(
      't1',
      'u1',
      'thx',
      undefined,
    );
  });
});
