import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ADMIN_PERMISSION_KEY } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

describe('ReferralsController', () => {
  let controller: ReferralsController;
  let service: any;

  beforeEach(async () => {
    service = {
      listPrograms: jest.fn(),
      createProgram: jest.fn(),
      updateProgram: jest.fn(),
      deleteProgram: jest.fn(),
      listRedemptions: jest.fn(),
      leaderboard: jest.fn(),
      summary: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReferralsController],
      providers: [{ provide: ReferralsService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(ReferralsController);
  });

  // ---------- routing happy path ----------

  it('GET /programs wraps in items', async () => {
    service.listPrograms.mockResolvedValue([{ id: 'p1' }]);
    const out = await controller.listPrograms();
    expect((out.data as any).items[0].id).toBe('p1');
  });

  it('POST /programs rejects missing required fields', async () => {
    await expect(controller.createProgram({} as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('POST /programs passes through valid input', async () => {
    service.createProgram.mockResolvedValue({ id: 'p-new' });
    const out = await controller.createProgram({
      name: '裂变 1',
      inviterReward: 100,
      inviteeReward: 50,
      rewardCondition: 'REGISTER',
    });
    expect(service.createProgram).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '裂变 1',
        inviterReward: 100,
        inviteeReward: 50,
        rewardCondition: 'REGISTER',
      }),
    );
    expect((out.data as any).id).toBe('p-new');
  });

  it('PUT /programs/:id passes id+update', async () => {
    service.updateProgram.mockResolvedValue({ id: 'p1' });
    await controller.updateProgram('p1', { inviterReward: 200 });
    expect(service.updateProgram).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ inviterReward: 200 }),
    );
  });

  it('DELETE /programs/:id calls service.deleteProgram', async () => {
    service.deleteProgram.mockResolvedValue(undefined);
    const out = await controller.deleteProgram('p1');
    expect(service.deleteProgram).toHaveBeenCalledWith('p1');
    expect(out.data).toBeNull();
  });

  it('GET /redemptions parses pagination defaults', async () => {
    service.listRedemptions.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    await controller.listRedemptions({});
    expect(service.listRedemptions).toHaveBeenCalledWith({
      programId: undefined,
      inviterUserId: undefined,
      triggered: undefined,
      page: 1,
      pageSize: 20,
    });
  });

  it('GET /redemptions parses programId filter + custom pagination', async () => {
    service.listRedemptions.mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      pageSize: 50,
      totalPages: 0,
    });
    await controller.listRedemptions({
      programId: 'p1',
      page: '2',
      pageSize: '50',
      triggered: 'false',
    });
    expect(service.listRedemptions).toHaveBeenCalledWith({
      programId: 'p1',
      inviterUserId: undefined,
      triggered: false,
      page: 2,
      pageSize: 50,
    });
  });

  it('GET /leaderboard with days param', async () => {
    service.leaderboard.mockResolvedValue({ items: [] });
    await controller.leaderboard({ programId: 'p1', days: '30' });
    expect(service.leaderboard).toHaveBeenCalledWith({
      programId: 'p1',
      days: 30,
    });
  });

  it('GET /leaderboard without filters', async () => {
    service.leaderboard.mockResolvedValue({ items: [] });
    await controller.leaderboard({});
    expect(service.leaderboard).toHaveBeenCalledWith({
      programId: undefined,
      days: undefined,
    });
  });

  it('GET /summary passes programId filter', async () => {
    service.summary.mockResolvedValue({
      totalInviters: 0,
      totalInvitees: 0,
      totalRedemptions: 0,
      totalAttempts: 0,
      conversionRate: 0,
      totalRewardIssued: 0,
      perProgram: {},
    });
    const out = await controller.summary({ programId: 'p1' });
    expect(service.summary).toHaveBeenCalledWith({ programId: 'p1' });
    expect((out.data as any).conversionRate).toBe(0);
  });

  it('GET /summary without filters', async () => {
    service.summary.mockResolvedValue({ perProgram: {} });
    await controller.summary({});
    expect(service.summary).toHaveBeenCalledWith({ programId: undefined });
  });

  // ---------- permission metadata ----------

  describe('permission metadata', () => {
    const reflector = new Reflector();

    it.each([
      ['listPrograms', 'admin.page.referrals.view'],
      ['createProgram', 'admin.page.referrals.manage'],
      ['updateProgram', 'admin.page.referrals.manage'],
      ['deleteProgram', 'admin.page.referrals.manage'],
      ['listRedemptions', 'admin.page.referrals.view'],
      ['leaderboard', 'admin.page.referrals.view'],
      ['summary', 'admin.page.referrals.view'],
    ])('%s requires permission %s', (methodName, perm) => {
      const handler = (ReferralsController.prototype as any)[methodName];
      const meta = reflector.get<string[]>(ADMIN_PERMISSION_KEY, handler);
      expect(meta).toEqual([perm]);
    });
  });
});
