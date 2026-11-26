/**
 * FunnelController 测试 —— 路由权限装饰器 + days/segmentId query parsing。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ADMIN_PERMISSION_KEY } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { FunnelController } from './funnel.controller';
import { FunnelService } from './funnel.service';

describe('FunnelController', () => {
  let controller: FunnelController;
  let service: any;

  beforeEach(async () => {
    service = {
      getOverallFunnel: jest.fn(),
      getSubscriptionFunnel: jest.fn(),
      getPaygFunnel: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FunnelController],
      providers: [{ provide: FunnelService, useValue: service }],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(FunnelController);
  });

  // -------------------- happy path --------------------

  it('overall: parses days + segmentId, returns ApiResponse envelope', async () => {
    const fakeData = {
      steps: [
        { key: 'register', label: '注册', value: 10 },
        { key: 'activated', label: '激活', value: 8 },
        { key: 'paid', label: '付费', value: 5 },
        { key: 'retained', label: '续订', value: 2 },
      ],
    };
    service.getOverallFunnel.mockResolvedValueOnce(fakeData);

    const out = await controller.overall({ days: '7', segmentId: ' seg1 ' });

    expect(out.code).toBe(0);
    expect(out.data).toEqual(fakeData);
    expect(service.getOverallFunnel).toHaveBeenCalledWith({
      days: 7,
      segmentId: 'seg1',
    });
  });

  it('overall: missing days defaults to 30; empty segmentId becomes undefined', async () => {
    service.getOverallFunnel.mockResolvedValueOnce({ steps: [] });
    await controller.overall({});
    expect(service.getOverallFunnel).toHaveBeenCalledWith({
      days: 30,
      segmentId: undefined,
    });
  });

  it('overall: bogus days passes through (service normalizeDays will fallback)', async () => {
    service.getOverallFunnel.mockResolvedValueOnce({ steps: [] });
    await controller.overall({ days: 'foo' });
    // controller passes 30 fallback for non-finite
    expect(service.getOverallFunnel.mock.calls[0][0].days).toBe(30);
  });

  it('subscription: parses days', async () => {
    service.getSubscriptionFunnel.mockResolvedValueOnce({ steps: [] });
    await controller.subscription({ days: '90' });
    expect(service.getSubscriptionFunnel).toHaveBeenCalledWith({ days: 90 });
  });

  it('payg: parses days', async () => {
    service.getPaygFunnel.mockResolvedValueOnce({ steps: [] });
    await controller.payg({ days: '7' });
    expect(service.getPaygFunnel).toHaveBeenCalledWith({ days: 7 });
  });

  // -------------------- 权限元数据 --------------------

  it('decorators: all 3 endpoints require the funnel page permission', () => {
    const permsOf = (method: string): string[] | undefined =>
      Reflect.getMetadata(
        ADMIN_PERMISSION_KEY,
        (FunnelController.prototype as any)[method],
      );
    expect(permsOf('overall')).toEqual(['admin.page.funnel.view']);
    expect(permsOf('subscription')).toEqual(['admin.page.funnel.view']);
    expect(permsOf('payg')).toEqual(['admin.page.funnel.view']);
  });
});
