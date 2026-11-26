import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { generateKeyPairSync } from 'crypto';
import {
  ADMIN_NO_PERMISSION_REQUIRED_KEY,
  ADMIN_PERMISSION_KEY,
  ADMIN_PRESET_ROLE_KEY,
} from '../common/decorators/admin-permission.decorator';
import { BillingAdminController } from './billing-admin.controller';

describe('BillingAdminController finance report query controls', () => {
  it('forwards an explicit overview refresh to the cached computation path', async () => {
    const billingAdmin = {
      getCachedFinanceReportOverview: jest.fn().mockResolvedValue({ period: { month: '2026-09' } }),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).billingAdmin = billingAdmin;

    await controller.getFinanceReportOverview('2026-09', undefined, 'true');

    expect(billingAdmin.getCachedFinanceReportOverview)
      .toHaveBeenCalledWith('2026-09', undefined, true);
  });

  it('forwards accounting month, cursor pagination, and structured filters', async () => {
    const billingAdmin = {
      getFinanceReportDetail: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).billingAdmin = billingAdmin;

    const result = await controller.getFinanceReportDetail(
      '2026-05',
      'apiUsage',
      'PAY_AS_YOU_GO',
      '20',
      'cursor-token',
      'model',
      'gpt-4',
    );

    expect(billingAdmin.getFinanceReportDetail).toHaveBeenCalledWith({
      month: '2026-05',
      tab: 'apiUsage',
      billingMode: 'PAY_AS_YOU_GO',
      pageSize: 20,
      cursor: 'cursor-token',
      filterField: 'model',
      filterValue: 'gpt-4',
    });
    expect(result).toEqual({
      code: 0,
      message: 'ok',
      data: { rows: [] },
    });
  });
});

describe('BillingAdminController gateway evidence settlement', () => {
  it('requires settle authority and forwards the selected evidence with actor identity', async () => {
    const settled = {
      action: 'deducted',
      requestId: 'request-1',
      revision: 8,
    };
    const gatewayRequestEventBilling = {
      reconcileAndSettle: jest.fn().mockResolvedValue(settled),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).gatewayRequestEventBilling = gatewayRequestEventBilling;

    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.reconcileAndSettleGatewayEvent,
    );
    const result = await controller.reconcileAndSettleGatewayEvent(
      'request-1',
      {
        evidenceId: 'evidence-2',
        expectedRevision: 6,
        reason: 'provider usage verified',
        idempotencyKey: 'settle-request-1-revision-6',
      },
      'finance-admin-1',
    );

    expect(requiredPermissions).toEqual([
      'admin.page.gateway_billing_events.settle',
    ]);
    expect(Reflect.getMetadata(
      ADMIN_PRESET_ROLE_KEY,
      BillingAdminController.prototype.reconcileAndSettleGatewayEvent,
    )).toEqual(['finance', 'super_admin']);
    expect(gatewayRequestEventBilling.reconcileAndSettle).toHaveBeenCalledWith(
      'request-1',
      'evidence-2',
      {
        expectedRevision: 6,
        reason: 'provider usage verified',
        idempotencyKey: 'settle-request-1-revision-6',
        actorId: 'finance-admin-1',
      },
    );
    expect(result).toEqual({
      code: 0,
      message: '权威证据已结算',
      data: settled,
    });
  });

  it('keeps terminal delta absorption behind finance authority and selected evidence', async () => {
    const absorbed = { requestId: 'request-1', revision: 9 };
    const gatewayRequestEventBilling = {
      absorbTerminalDelta: jest.fn().mockResolvedValue(absorbed),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).gatewayRequestEventBilling = gatewayRequestEventBilling;

    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.absorbGatewayEventDelta,
    );
    const result = await controller.absorbGatewayEventDelta(
      'request-1',
      {
        evidenceId: 'evidence-correction-2',
        expectedRevision: 8,
        reason: 'July undercount absorbed by platform',
        idempotencyKey: 'absorb-delta-request-1-revision-8',
      },
      'finance-admin-1',
    );

    expect(requiredPermissions).toEqual([
      'admin.page.gateway_billing_events.absorb',
    ]);
    expect(Reflect.getMetadata(
      ADMIN_PRESET_ROLE_KEY,
      BillingAdminController.prototype.absorbGatewayEventDelta,
    )).toEqual(['finance', 'super_admin']);
    expect(gatewayRequestEventBilling.absorbTerminalDelta).toHaveBeenCalledWith(
      'request-1',
      'evidence-correction-2',
      {
        expectedRevision: 8,
        reason: 'July undercount absorbed by platform',
        idempotencyKey: 'absorb-delta-request-1-revision-8',
        actorId: 'finance-admin-1',
      },
    );
    expect(result).toEqual({
      code: 0,
      message: '已结算请求的少计差额已由平台吸收',
      data: absorbed,
    });
  });

  it('forwards the explicit currency-repair proof for unanchored absorption', async () => {
    const absorbed = { requestId: 'request-currency-1', revision: 2 };
    const gatewayRequestEventBilling = {
      absorb: jest.fn().mockResolvedValue(absorbed),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).gatewayRequestEventBilling = gatewayRequestEventBilling;
    const manifestHash = 'a'.repeat(64);

    const result = await controller.absorbGatewayEvent(
      'request-currency-1',
      {
        expectedRevision: 1,
        reason: 'approved legacy currency closure',
        idempotencyKey: 'absorb-currency-request-1',
        protocol: 'gateway-unanchored-absorb-v1',
        currencyRepairRunId: 'currency-run-1',
        currencyRepairItemId: 'currency-item-1',
        manifestHash,
      },
      'finance-admin-1',
    );

    expect(gatewayRequestEventBilling.absorb).toHaveBeenCalledWith(
      'request-currency-1',
      {
        expectedRevision: 1,
        reason: 'approved legacy currency closure',
        idempotencyKey: 'absorb-currency-request-1',
        actorId: 'finance-admin-1',
        protocol: 'gateway-unanchored-absorb-v1',
        currencyRepairRunId: 'currency-run-1',
        currencyRepairItemId: 'currency-item-1',
        manifestHash,
      },
    );
    expect(result.data).toBe(absorbed);
  });

  it('limits every customer-funds or platform-loss action to finance presets', () => {
    for (const handler of [
      BillingAdminController.prototype.reconcileAndSettleGatewayEvent,
      BillingAdminController.prototype.absorbGatewayEvent,
      BillingAdminController.prototype.absorbGatewayEventDelta,
    ]) {
      expect(Reflect.getMetadata(ADMIN_PRESET_ROLE_KEY, handler))
        .toEqual(['finance', 'super_admin']);
    }
    expect(Reflect.getMetadata(
      ADMIN_PRESET_ROLE_KEY,
      BillingAdminController.prototype.markGatewayEventManualReview,
    )).toBeUndefined();
    expect(Reflect.getMetadata(
      ADMIN_PRESET_ROLE_KEY,
      BillingAdminController.prototype.retryGatewayEvent,
    )).toBeUndefined();
  });
});

describe('BillingAdminController historical platform loss batches', () => {
  it('uses independent prepare/approve/export permissions and forwards maker/checker identities', async () => {
    const service = {
      preview: jest.fn().mockResolvedValue({ status: 'READY', fingerprint: 'f'.repeat(64) }),
      create: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'PREPARED' }),
      approveAndPost: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'POSTED' }),
      export: jest.fn().mockResolvedValue({ schemaVersion: 'historical-platform-loss-export.v1' }),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).historicalPlatformLosses = service;
    const body = { provider: 'zhipu', lines: [] } as any;

    await controller.previewHistoricalPlatformLossBatch(body);
    await controller.createHistoricalPlatformLossBatch(body, 'maker-1');
    await controller.approveAndPostHistoricalPlatformLossBatch(
      'batch-1',
      {
        expectedRevision: 0,
        expectedFingerprint: 'f'.repeat(64),
        reason: 'checked against provider statement',
        idempotencyKey: 'post-1',
      },
      'checker-1',
    );
    await controller.exportHistoricalPlatformLossBatch('batch-1');

    expect(Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.previewHistoricalPlatformLossBatch,
    )).toEqual(['admin.page.historical_platform_losses.prepare']);
    expect(Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.approveAndPostHistoricalPlatformLossBatch,
    )).toEqual(['admin.page.historical_platform_losses.approve_post']);
    expect(Reflect.getMetadata(
      ADMIN_PRESET_ROLE_KEY,
      BillingAdminController.prototype.approveAndPostHistoricalPlatformLossBatch,
    )).toEqual(['finance', 'super_admin']);
    expect(Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.exportHistoricalPlatformLossBatch,
    )).toEqual(['admin.page.historical_platform_losses.export']);
    expect(service.create).toHaveBeenCalledWith(body, 'maker-1');
    expect(service.approveAndPost).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({ idempotencyKey: 'post-1' }),
      'checker-1',
    );
  });
});

describe('BillingAdminController product payment callback configuration', () => {
  function buildController() {
    const productService = {
      create: jest.fn(async (body: unknown) => body),
      update: jest.fn(async (_id: string, body: unknown) => body),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).productService = productService;
    return { controller, productService };
  }

  it('forwards callback origins when creating a product', async () => {
    const { controller, productService } = buildController();
    const allowedPaymentCallbackOrigins = ['https://product.example.com'];

    await controller.createProduct({
      name: 'Product',
      slug: 'product',
      allowedPaymentCallbackOrigins,
    });

    expect(productService.create).toHaveBeenCalledWith({
      name: 'Product',
      slug: 'product',
      allowedPaymentCallbackOrigins,
    });
  });

  it('forwards null when switching a product to global fallback', async () => {
    const { controller, productService } = buildController();

    await controller.updateProduct('product-1', {
      allowedPaymentCallbackOrigins: null,
    });

    expect(productService.update).toHaveBeenCalledWith('product-1', {
      allowedPaymentCallbackOrigins: null,
    });
  });
});

function sqlText(query: unknown): string {
  const sql = query as { sql?: string; text?: string; strings?: string[] };
  return sql.sql ?? sql.text ?? sql.strings?.join('') ?? '';
}

describe('BillingAdminController model pricing internal access', () => {
  it('allows non-admin internal callers while requiring model catalog access for admin-api reads', () => {
    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.listModelPricing,
    );
    const noAdminPermissionRequired = Reflect.getMetadata(
      ADMIN_NO_PERMISSION_REQUIRED_KEY,
      BillingAdminController.prototype.listModelPricing,
    );

    expect(requiredPermissions).toEqual(['admin.catalog.models.view']);
    expect(noAdminPermissionRequired).toBe(true);
  });

  it('allows non-admin internal callers while requiring PAYG page view for admin-api reads', () => {
    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.listPaygModelPricing,
    );
    const noAdminPermissionRequired = Reflect.getMetadata(
      ADMIN_NO_PERMISSION_REQUIRED_KEY,
      BillingAdminController.prototype.listPaygModelPricing,
    );

    expect(requiredPermissions).toEqual(['admin.page.payg_pricing.view']);
    expect(noAdminPermissionRequired).toBe(true);
  });
});

describe('BillingAdminController deployment currency output', () => {
  function buildController() {
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).systemConfig = {
      getDeploymentConfig: jest.fn().mockResolvedValue({ region: 'domestic', currency: 'cny' }),
    };
    (controller as any).config = { get: jest.fn() };
    return controller;
  }

  it('uses the deployment symbol in manual funding limit errors', async () => {
    const controller = buildController();

    await expect(controller.adjustBalance('user-1', {
      amountCents: 2_500_001,
      idempotencyKey: 'adjust-1',
    })).rejects.toThrow('单次调额不能超过 ¥25,000.00');

    await expect(controller.issuePaygVoucher('tenant-1', {
      userId: 'user-1',
      amountCents: 2_500_001,
      reason: 'test',
      idempotencyKey: 'voucher-1',
    })).rejects.toThrow('单次发券不能超过 ¥25,000.00');
  });

  it('returns deployment currency metadata from workspace balances', async () => {
    const controller = buildController();
    (controller as any).billingService = {
      getWorkspaceBalanceReport: jest.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        balanceCents: 100,
        balanceUsd: 1,
        accountBalanceCents: 100,
        accountBalanceUsd: 1,
      }),
    };
    (controller as any).prisma = {
      tokenUsage: { groupBy: jest.fn().mockResolvedValue([]) },
    };

    const result = await controller.getWorkspaceBalances({ tenantIds: ['tenant-1'] });

    expect((result.data as any[])[0]).toEqual(expect.objectContaining({
      currency: 'cny',
      currencyCode: 'CNY',
      currencySymbol: '¥',
    }));
  });
});

describe('BillingAdminController user scoped internal access', () => {
  function buildController() {
    const billingAdmin = {
      listRecentOrdersForUser: jest.fn().mockResolvedValue([
        {
          id: 'order-1',
          amountCents: 1234,
          status: 'PAID',
          createdAt: new Date('2026-05-26T00:00:00.000Z'),
        },
      ]),
    };
    const controller = new BillingAdminController(
      billingAdmin as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // selfopNegativeDeductConfig
    );
    return { controller, billingAdmin };
  }

  it('requires user page view permission to read recent orders in user detail', async () => {
    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.listRecentOrdersForUser,
    );
    const { controller, billingAdmin } = buildController();

    const result = await controller.listRecentOrdersForUser('user-1', '50');

    expect(requiredPermissions).toEqual(['admin.page.users.view']);
    expect(billingAdmin.listRecentOrdersForUser).toHaveBeenCalledWith('user-1', 20);
    expect(result.data).toEqual({
      items: [
        {
          id: 'order-1',
          amountCents: 1234,
          status: 'PAID',
          createdAt: new Date('2026-05-26T00:00:00.000Z'),
        },
      ],
    });
  });
});

describe('BillingAdminController channel protocol templates', () => {
  it('proxies protocol template metadata through internal admin API', async () => {
    const payload = { contractVersion: '2026-06-01', items: [] };
    const channelService = {
      getProtocolTemplates: jest.fn().mockReturnValue(payload),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).channelService = channelService;

    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.getChannelProtocolTemplates,
    );
    const result = await controller.getChannelProtocolTemplates();

    expect(requiredPermissions).toEqual(['admin.catalog.channels.view']);
    expect(channelService.getProtocolTemplates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ code: 0, message: 'ok', data: payload });
  });
});

describe('BillingAdminController deployment config', () => {
  function buildController() {
    const systemConfig = {
      applyDeploymentConfig: jest.fn(async (value) => value),
      set: jest.fn(async (_key, value) => value),
    };
    const controller = Object.create(BillingAdminController.prototype) as BillingAdminController;
    (controller as any).systemConfig = systemConfig;
    return { controller, systemConfig };
  }

  it('applies one versioned deployment snapshot from internal admin API', async () => {
    const { controller, systemConfig } = buildController();
    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.updateDeploymentConfig,
    );
    const snapshot = {
      version: '8',
      region: 'domestic',
      provider: 'authing',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    };
    const result = await controller.updateDeploymentConfig(snapshot);

    expect(requiredPermissions).toEqual(['admin.page.system_config.manage']);
    expect(systemConfig.applyDeploymentConfig).toHaveBeenCalledWith(snapshot);
    expect(result).toEqual({
      code: 0,
      message: '部署配置已同步',
      data: snapshot,
    });
  });

  it('persists normalized storage config from internal admin API without deployment bucket/region', async () => {
    const { controller, systemConfig } = buildController();

    const requiredPermissions = Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      BillingAdminController.prototype.updateStorageConfig,
    );
    const result = await controller.updateStorageConfig({
      provider: ' s3 ',
      bucket: ' invoices ',
      s3Region: ' ap-east-1 ',
      s3Endpoint: '',
      s3Prefix: ' billing-test ',
      s3ForcePathStyle: 'false',
    });

    expect(requiredPermissions).toEqual(['admin.page.system_config.manage']);
    expect(systemConfig.set).toHaveBeenCalledWith('storageConfig', {
      provider: 's3',
      s3Prefix: 'billing-test',
      s3ForcePathStyle: false,
    });
    expect(result).toEqual({
      code: 0,
      message: '对象存储配置已保存',
      data: {
        provider: 's3',
        s3Prefix: 'billing-test',
        s3ForcePathStyle: false,
      },
    });
  });

  it('allows partial storage config and strips deployment bucket/region', async () => {
    const { controller, systemConfig } = buildController();

    const result = await controller.updateStorageConfig({
      provider: 's3',
      bucket: ' invoices ',
      s3Region: ' ap-east-1 ',
    });

    expect(systemConfig.set).toHaveBeenCalledWith('storageConfig', { provider: 's3' });
    expect(result.data).toEqual({ provider: 's3' });
  });

  it('normalizes aliyun oss storage provider and strips S3-only fields', async () => {
    const { controller, systemConfig } = buildController();

    const result = await controller.updateStorageConfig({
      provider: 'oss',
      bucket: ' invoices ',
      s3Region: ' cn-hangzhou ',
      s3Endpoint: ' https://s3.should-not-persist.test ',
      s3ForcePathStyle: 'true',
      ossEndpoint: ' https://oss-cn-hangzhou.aliyuncs.com ',
      s3AccessKeyId: ' ak ',
      s3SecretAccessKey: ' sk ',
    });

    expect(systemConfig.set).toHaveBeenCalledWith('storageConfig', {
      provider: 'aliyun_oss',
      ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      s3AccessKeyId: 'ak',
      s3SecretAccessKey: 'sk',
    });
    expect(result.data).toEqual(expect.objectContaining({ provider: 'aliyun_oss' }));
    expect(result.data).not.toHaveProperty('s3Endpoint');
    expect(result.data).not.toHaveProperty('s3ForcePathStyle');
  });

  it('infers aliyun oss provider from legacy ossEndpoint without requiring credentials on sync', async () => {
    const { controller, systemConfig } = buildController();

    const result = await controller.updateStorageConfig({
      bucket: 'invoices',
      s3Region: 'cn-hangzhou',
      ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    });

    expect(systemConfig.set).toHaveBeenCalledWith('storageConfig', {
      provider: 'aliyun_oss',
      ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    });
    expect(result.data).toEqual({
      provider: 'aliyun_oss',
      ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    });
  });
});

describe('BillingAdminController balance adjustment validation', () => {
  function buildController() {
    const billingService = {
      adjust: jest.fn(),
      applyClassifiedBalanceAdjustment: jest.fn().mockResolvedValue({ direction: 'CREDIT' }),
    };
    const prisma: any = {
      user: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({ id: 'user-1', email: 'user@example.com' }),
      },
    };
    const controller = new BillingAdminController(
      {} as any,
      billingService as any,
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // selfopNegativeDeductConfig
    );
    return { controller, billingService, prisma };
  }

  it.each([
    ['zero', 0],
    ['fractional cents', 100.5],
    ['NaN', Number.NaN],
    ['above positive limit', 2_500_001],
    ['below negative limit', -2_500_001],
    ['string value', '100'],
  ])('rejects invalid amountCents: %s', async (_label, amountCents) => {
    const { controller, billingService, prisma } = buildController();

    await expect(
      controller.adjustBalance('user-1', {
        amountCents: amountCents as number,
        description: 'manual adjustment',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(billingService.adjust).not.toHaveBeenCalled();
  });

  it('forwards a classified billing adjustment with audit fields intact', async () => {
    const { controller, billingService } = buildController();

    const result = await controller.applyBillingAdjustment('user-1', {
      amountCents: 1250,
      reasonCode: 'DISCOUNT_CORRECTION',
      description: 'August discount correction',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-1',
      tenantId: 'tenant-1',
      billingAccountId: 'account-1',
    });

    expect(result.data).toEqual({ direction: 'CREDIT' });
    expect(billingService.applyClassifiedBalanceAdjustment).toHaveBeenCalledWith('user-1', {
      amountCents: 1250,
      reasonCode: 'DISCOUNT_CORRECTION',
      description: 'August discount correction',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-1',
      tenantId: 'tenant-1',
      billingAccountId: 'account-1',
      productId: undefined,
    });
  });

  it('rejects an unclassified billing adjustment', async () => {
    const { controller, billingService } = buildController();

    await expect(controller.applyBillingAdjustment('user-1', {
      amountCents: 1250,
      reasonCode: 'FREE_TEXT',
      description: 'invalid reason',
      idempotencyKey: 'adjustment-key-2',
    })).rejects.toThrow('reasonCode 无效');

    expect(billingService.applyClassifiedBalanceAdjustment).not.toHaveBeenCalled();
  });
});

describe('BillingAdminController voucher expiry normalization', () => {
  function buildController() {
    const billingService = {
      issueVoucher: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new BillingAdminController(
      {} as any,
      billingService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // selfopNegativeDeductConfig
    );
    return { controller, billingService };
  }

  it('stores a date-only voucher expiry as the next business day at 00:00 Asia/Shanghai', async () => {
    const { controller, billingService } = buildController();

    await controller.issuePaygVoucher('tenant-1', {
      userId: 'user-1',
      amountCents: 1000,
      reason: '测试',
      expiresAt: '2030-01-01',
      idempotencyKey: 'voucher-key-1',
    });

    expect(billingService.issueVoucher).toHaveBeenCalledWith(
      'user-1',
      1000,
      '测试',
      expect.objectContaining({
        tenantId: 'tenant-1',
        expiresAt: new Date('2030-01-01T16:00:00.000Z'),
        idempotencyKey: 'voucher-key-1',
      }),
    );
  });

  it('ignores time-of-day from legacy ISO voucher expiry payloads', async () => {
    const { controller, billingService } = buildController();

    await controller.issuePaygVoucher('tenant-1', {
      userId: 'user-1',
      amountCents: 1000,
      reason: '测试',
      expiresAt: '2030-01-01T10:15:20.000+08:00',
      idempotencyKey: 'voucher-key-2',
    });

    expect(billingService.issueVoucher).toHaveBeenCalledWith(
      'user-1',
      1000,
      '测试',
      expect.objectContaining({
        tenantId: 'tenant-1',
        expiresAt: new Date('2030-01-01T16:00:00.000Z'),
        idempotencyKey: 'voucher-key-2',
      }),
    );
  });
});

describe('BillingAdminController payment instance validation', () => {
  function rawPemBody(pem: string): string {
    return pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, '');
  }

  function keyPair() {
    return generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
  }

  function buildController() {
    return Object.create(BillingAdminController.prototype) as any;
  }

  it('rejects using the app public key as the Alipay public key', () => {
    const appKeyPair = keyPair();
    const controller = buildController();

    expect(() =>
      controller.validatePaymentInstanceConfig('alipay', {
        privateKey: rawPemBody(appKeyPair.privateKey),
        alipayPublicKey: rawPemBody(appKeyPair.publicKey),
      }),
    ).toThrow(BadRequestException);
  });

  it('allows a distinct Alipay public key', () => {
    const appKeyPair = keyPair();
    const alipayKeyPair = keyPair();
    const controller = buildController();

    expect(() =>
      controller.validatePaymentInstanceConfig('alipay', {
        privateKey: rawPemBody(appKeyPair.privateKey),
        alipayPublicKey: rawPemBody(alipayKeyPair.publicKey),
      }),
    ).not.toThrow();
  });
});

describe('BillingAdminController subscription account operations', () => {
  function buildController() {
    const billingAdmin = {
      listSubscriptions: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    const creditService = {
      addBonus: jest.fn().mockResolvedValue(undefined),
      getAuthoritativeBalances: jest.fn().mockResolvedValue({ quota: 0, bonus: 0, grant: 0, total: 0 }),
      grantQuota: jest.fn().mockResolvedValue(undefined),
    };
    const prisma: any = {
      subscriptionPeriod: {
        findFirst: jest.fn(),
      },
    };
    const productSync = {
      notifyCreditChanged: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new BillingAdminController(
      billingAdmin as any,
      {} as any,
      creditService as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
      productSync as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // selfopNegativeDeductConfig
    );
    return { controller, billingAdmin, creditService, prisma, productSync };
  }

  it('passes userId filter to subscription listing', async () => {
    const { controller, billingAdmin } = buildController();

    await controller.listSubscriptions({
      page: '2',
      pageSize: '30',
      status: 'ACTIVE',
      productId: 'prod-1',
      userId: 'user-1',
    });

    expect(billingAdmin.listSubscriptions).toHaveBeenCalledWith({
      page: 2,
      pageSize: 30,
      status: 'ACTIVE',
      expiringDays: undefined,
      productId: 'prod-1',
      userId: 'user-1',
    });
  });

  it('grants credits to the selected subscription account', async () => {
    const { controller, creditService, prisma, productSync } = buildController();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-1',
      userId: 'user-1',
      user: { id: 'user-1', email: 'a@example.com' },
      product: { slug: 'code' },
    });

    await controller.grantSubscriptionCredits('period-1', {
      amount: 500,
      reason: ' manual grant ',
      idempotencyKey: 'grant-key-1',
    });

    expect(creditService.addBonus).toHaveBeenCalledWith(
      'period-1',
      'user-1',
      500,
      'admin_grant:manual grant',
      { idempotencyKey: 'grant-key-1' },
    );
    expect(productSync.notifyCreditChanged).toHaveBeenCalledWith('a@example.com', 'code');
  });

  it('rejects oversized manual grants before touching subscription or credit state', async () => {
    const { controller, creditService, prisma } = buildController();

    await expect(
      controller.grantSubscriptionCredits('sub-1', {
        amount: 10_001,
        reason: 'manual grant',
        idempotencyKey: 'grant-key-oversized',
      }),
    ).rejects.toThrow('单次积分赠送不能超过 10000');

    expect(prisma.subscriptionPeriod.findFirst).not.toHaveBeenCalled();
    expect(creditService.addBonus).not.toHaveBeenCalled();
  });

  it('rejects missing or inactive subscription accounts before adding credits', async () => {
    const { controller, creditService, prisma } = buildController();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    await expect(
      controller.grantSubscriptionCredits('missing', {
        amount: 500,
        reason: 'manual grant',
        idempotencyKey: 'grant-key-missing',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(creditService.addBonus).not.toHaveBeenCalled();
  });
});

describe('BillingAdminController default free plan resolution', () => {
  function buildController(candidates: any[]) {
    const controller = Object.create(BillingAdminController.prototype) as any;
    controller.prisma = {
      plan: {
        findMany: jest.fn().mockResolvedValue(candidates.map((candidate) => ({
          billingPeriod: 'monthly',
          prices: [],
          ...candidate,
        }))),
      },
    };
    return controller;
  }

  it('uses the unique active product default plan instead of relying on the literal free id', async () => {
    const configured = {
      id: 'starter-plan-v2',
      name: 'Starter',
      productId: 'product-1',
      monthlyCredits: 100,
      product: { defaultPlanId: 'starter-plan-v2' },
    };
    const controller = buildController([
      {
        id: 'free',
        name: 'Legacy Free',
        productId: 'legacy-product',
        monthlyCredits: 10,
        product: { defaultPlanId: null },
      },
      configured,
    ]);

    await expect(controller.resolveDefaultFreePlan()).resolves.toEqual({
      id: configured.id,
      name: configured.name,
      productId: configured.productId,
      monthlyCredits: configured.monthlyCredits,
    });
    expect(controller.prisma.plan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isActive: true,
        deletedAt: null,
        OR: [
          { billingPeriod: 'monthly', monthlyPrice: 0 },
          { billingPeriod: 'quarterly', quarterlyPrice: 0 },
          { billingPeriod: 'yearly', yearlyPrice: 0 },
        ],
      }),
    }));
  });

  it('keeps the legacy free id as a compatibility fallback', async () => {
    const controller = buildController([{
      id: 'free',
      name: 'Legacy Free',
      productId: 'legacy-product',
      monthlyCredits: 10,
      product: { defaultPlanId: null },
    }]);

    await expect(controller.resolveDefaultFreePlan()).resolves.toEqual({
      id: 'free',
      name: 'Legacy Free',
      productId: 'legacy-product',
      monthlyCredits: 10,
    });
  });

  it('reports an unavailable service when multiple free plans are ambiguous', async () => {
    const controller = buildController([
      {
        id: 'starter-a',
        name: 'Starter A',
        productId: 'product-a',
        monthlyCredits: 10,
        product: { defaultPlanId: null },
      },
      {
        id: 'starter-b',
        name: 'Starter B',
        productId: 'product-b',
        monthlyCredits: 10,
        product: { defaultPlanId: null },
      },
    ]);

    await expect(controller.resolveDefaultFreePlan())
      .rejects.toThrow(ServiceUnavailableException);
  });

  it('does not auto-activate a plan with a paid regional price', async () => {
    const controller = buildController([{
      id: 'starter-plan-v2',
      name: 'Starter',
      productId: 'product-1',
      monthlyCredits: 100,
      billingPeriod: 'monthly',
      prices: [{ monthlyPrice: 100, quarterlyPrice: 0, yearlyPrice: 0 }],
      product: { defaultPlanId: 'starter-plan-v2' },
    }]);

    await expect(controller.resolveDefaultFreePlan())
      .rejects.toThrow(ServiceUnavailableException);
  });
});

describe('BillingAdminController API key mirror', () => {
  function buildController() {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tenant-1' }),
      },
      product: {
        findFirst: jest.fn().mockResolvedValue({ id: 'product-1' }),
      },
      apiKey: {
        upsert: jest.fn().mockResolvedValue({ id: 'key-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'key-1', keyHash: 'hash-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      codingPlanEntitlement: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      tokenUsage: {
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: {}, _count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn((fn: (tx: any) => unknown) => fn(prisma));
    const publisherSync = {
      syncApiKeyMetaByIdRequired: jest.fn().mockResolvedValue(undefined),
      revokeApiKeyRequired: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceByIdRequired: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn().mockReturnValue(undefined),
      getOrThrow: jest.fn().mockReturnValue('a'.repeat(64)),
    };
    const controller = new BillingAdminController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      config as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      publisherSync as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // selfopNegativeDeductConfig
    );
    return { controller, prisma, publisherSync, config };
  }

  it('syncs publisher state from billing after mirroring an API key', async () => {
    const { controller, prisma, publisherSync } = buildController();

    await controller.mirrorApiKey('key-1', {
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productSlug: 'PAYG',
      name: 'Test key',
      prefix: 'rk-12345678',
      keyHash: 'hash-1',
      isActive: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
      ipWhitelist: ['203.0.113.10'],
      rateLimitRpm: 120,
    });

    expect(prisma.apiKey.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        ipWhitelist: '["203.0.113.10"]',
        rateLimitRpm: 120,
      }),
    }));
    expect(publisherSync.syncApiKeyMetaByIdRequired).toHaveBeenCalledWith('key-1');
  });

  it('rejects mirroring a provider-resale API key when provider entitlement is not ACTIVE', async () => {
    const { controller, prisma } = buildController();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-resale-1',
      productId: 'product-1',
      fulfillmentMode: 'provider_resale',
      providerEntitlement: {
        id: 'provider-entitlement-1',
        status: 'FAILED',
        productEndTime: null,
      },
    });

    await expect(controller.mirrorApiKey('key-1', {
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productSlug: 'PAYG',
      codingPlanEntitlementId: 'ent-resale-1',
      name: 'Test key',
      prefix: 'rk-12345678',
      keyHash: 'hash-1',
      isActive: true,
    })).rejects.toThrow('CodingPlan 上游权益尚未激活');

    expect(prisma.apiKey.upsert).not.toHaveBeenCalled();
  });

  it('allows provider-resale API key mirror while active key count is below the entitlement limit', async () => {
    const { controller, prisma } = buildController();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-resale-1',
      productId: 'product-1',
      fulfillmentMode: 'provider_resale',
      providerEntitlement: {
        id: 'provider-entitlement-1',
        status: 'ACTIVE',
        productEndTime: null,
      },
    });
    prisma.apiKey.count.mockResolvedValueOnce(4);

    await controller.mirrorApiKey('key-5', {
      id: 'key-5',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productSlug: 'PAYG',
      codingPlanEntitlementId: 'ent-resale-1',
      name: 'Fifth key',
      prefix: 'rk-55555555',
      keyHash: 'hash-5',
      isActive: true,
    });

    expect(prisma.apiKey.count).toHaveBeenCalledWith({
      where: {
        codingPlanEntitlementId: 'ent-resale-1',
        isActive: true,
        deletedAt: null,
        id: { not: 'key-5' },
      },
    });
    expect(prisma.apiKey.upsert).toHaveBeenCalled();
  });

  it('locks and revalidates a self-operated entitlement before active key upsert', async () => {
    const { controller, prisma } = buildController();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-self-1',
      productId: 'product-1',
      fulfillmentMode: 'platform_model_package',
      providerEntitlement: null,
    });

    await controller.mirrorApiKey('key-self-1', {
      id: 'key-self-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productSlug: 'PAYG',
      codingPlanEntitlementId: 'ent-self-1',
      name: 'Self-operated key',
      prefix: 'rk-self0001',
      keyHash: 'hash-self-1',
      isActive: true,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.codingPlanEntitlement.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.apiKey.upsert).toHaveBeenCalled();
  });

  it('rejects an active key mirror when the entitlement enters REFUNDING before the row lock', async () => {
    const { controller, prisma } = buildController();
    prisma.codingPlanEntitlement.findFirst
      .mockResolvedValueOnce({
        id: 'ent-self-1',
        productId: 'product-1',
        fulfillmentMode: 'platform_model_package',
        providerEntitlement: null,
      })
      .mockResolvedValueOnce(null);

    await expect(controller.mirrorApiKey('key-self-1', {
      id: 'key-self-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productSlug: 'PAYG',
      codingPlanEntitlementId: 'ent-self-1',
      name: 'Self-operated key',
      prefix: 'rk-self0001',
      keyHash: 'hash-self-1',
      isActive: true,
    })).rejects.toThrow('CodingPlan 权益不存在或不可用');

    expect(prisma.apiKey.upsert).not.toHaveBeenCalled();
  });

  it('rejects provider-resale API key mirror when active key count reaches the entitlement limit', async () => {
    const { controller, prisma } = buildController();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-resale-1',
      productId: 'product-1',
      fulfillmentMode: 'provider_resale',
      providerEntitlement: {
        id: 'provider-entitlement-1',
        status: 'ACTIVE',
        productEndTime: null,
      },
    });
    prisma.apiKey.count.mockResolvedValueOnce(5);

    await expect(controller.mirrorApiKey('key-6', {
      id: 'key-6',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productSlug: 'PAYG',
      codingPlanEntitlementId: 'ent-resale-1',
      name: 'Sixth key',
      prefix: 'rk-66666666',
      keyHash: 'hash-6',
      isActive: true,
    })).rejects.toThrow('CodingPlan 转售权益最多允许 5 把 active API Key');

    expect(prisma.apiKey.upsert).not.toHaveBeenCalled();
  });

  it('revokes publisher state from billing when a mirrored API key is deleted', async () => {
    const { controller, publisherSync } = buildController();

    await controller.revokeMirroredApiKey('key-1');

    expect(publisherSync.revokeApiKeyRequired).toHaveBeenCalledWith({ id: 'key-1', keyHash: 'hash-1' });
  });

  it('returns spend totals for mirrored API keys', async () => {
    const { controller, prisma } = buildController();
    prisma.tokenUsage.groupBy.mockResolvedValue([
      { apiKeyId: 'key-1', _sum: { costUsd: 12.34 } },
    ]);

    const result = await controller.getApiKeySpend({
      apiKeyIds: ['key-1', 'key-2', 'key-1', ''],
    });

    expect(prisma.tokenUsage.groupBy).toHaveBeenCalledWith({
      by: ['apiKeyId'],
      where: { apiKeyId: { in: ['key-1', 'key-2'] } },
      _sum: { costUsd: true },
    });
    expect(result.data).toEqual([
      { apiKeyId: 'key-1', usageUsd: 12.34, usageCents: 1234 },
      { apiKeyId: 'key-2', usageUsd: 0, usageCents: 0 },
    ]);
  });

  it('groups internal token usage reports by Asia/Shanghai date from UTC storage timestamps', async () => {
    const { controller, prisma } = buildController();

    await controller.getTokenUsageSummary({
      apiKeyIds: ['key-1'],
      tenantId: 'tenant-1',
      createdAt: {
        gte: new Date('2026-06-16T00:00:00.000Z'),
        lt: new Date('2026-06-24T00:00:00.000Z'),
      },
    });

    expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).toContain(
      `tu."created_at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'`,
    );

    prisma.$queryRaw.mockClear();
    await controller.getApiKeyUsageStats({
      apiKeyIds: ['key-1'],
      tenantId: 'tenant-1',
      cutoff: new Date('2026-06-16T00:00:00.000Z'),
    });

    expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).toContain(
      `tu."created_at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'`,
    );
  });
});

describe('BillingAdminController R6/R3b runtime switches (dependency guards)', () => {
  function buildSwitchController(store: Record<string, unknown> = {}) {
    const systemConfig = {
      getFresh: jest.fn(async (key: string) => store[key]),
    };
    const upsert = jest.fn(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      store[where.key] = JSON.parse(update.value);
    });
    // guardedSwitchWrite：$transaction 内 advisory lock + 守卫读(getFresh 带 tx) + upsert 写。
    const prisma = {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) =>
        fn({ $executeRaw: jest.fn().mockResolvedValue(undefined), systemConfig: { upsert } })),
    };
    const selfopConfig = { refresh: jest.fn().mockResolvedValue(undefined) };
    const args: unknown[] = Array.from({ length: 31 }, () => ({}));
    args[5] = prisma; // prisma 位（第 6 参）
    args[24] = systemConfig; // systemConfig 位（第 25 参）
    args[26] = selfopConfig; // selfopNegativeDeductConfig 位（第 27 参）
    const controller = new (BillingAdminController as any)(...args);
    return { controller, systemConfig, selfopConfig, store, upsert };
  }

  afterEach(() => {
    delete process.env.BILLING_SELFOP_NEGATIVE_DEDUCT_ENABLED;
    delete process.env.BILLING_CODING_PLAN_MONTHLY_REFRESH_ENABLED;
  });

  it('refuses to enable negative deduct while monthly refresh is not effective (hard gate)', async () => {
    const { controller, upsert } = buildSwitchController();
    await expect(controller.setSelfopNegativeDeduct({ enabled: true })).rejects.toThrow(/月度补发/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('enables negative deduct once monthly refresh is on, with immediate refresh', async () => {
    const { controller, selfopConfig, store } = buildSwitchController({
      coding_plan_monthly_refresh_enabled: true,
    });
    const res = await controller.setSelfopNegativeDeduct({ enabled: true });
    // PUT 响应与 GET 同构（含 gatewayNegativeEnv 诊断），前端整体替换状态不丢诊断行。
    expect(res.data).toMatchObject({
      adminEnabled: true,
      effectiveEnabled: true,
      gatewayNegativeEnv: false,
    });
    expect(store.selfop_negative_deduct_enabled).toBe(true);
    expect(selfopConfig.refresh).toHaveBeenCalledTimes(1);
  });

  it('refuses to disable monthly refresh while negative deduct is still effective', async () => {
    const { controller, upsert } = buildSwitchController({
      coding_plan_monthly_refresh_enabled: true,
      selfop_negative_deduct_enabled: true,
    });
    await expect(controller.setCodingPlanMonthlyRefresh({ enabled: false })).rejects.toThrow(/负额/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('fences reverse-order disable within the cluster convergence window (P1)', async () => {
    // 反序：先关负额（写 disabled_at=now），立即关月度 → 被集群收敛 fence 拦（elapsed<45s）。
    const { controller, store } = buildSwitchController({
      coding_plan_monthly_refresh_enabled: true,
      selfop_negative_deduct_enabled: true,
    });
    await controller.setSelfopNegativeDeduct({ enabled: false });
    await expect(controller.setCodingPlanMonthlyRefresh({ enabled: false })).rejects.toThrow(/收敛/);
    expect(store.coding_plan_monthly_refresh_enabled).toBe(true); // 未被关闭
  });

  it('allows disabling monthly refresh once the convergence window has elapsed', async () => {
    // 负额已关且关闭时间戳早于收敛窗口（46s 前）→ 集群已收敛，关月度放行。
    const past = new Date(Date.now() - 46_000).toISOString();
    const { controller, store } = buildSwitchController({
      coding_plan_monthly_refresh_enabled: true,
      selfop_negative_deduct_enabled: false,
      selfop_negative_deduct_disabled_at: past,
    });
    const res = await controller.setCodingPlanMonthlyRefresh({ enabled: false });
    expect(res.data).toMatchObject({ adminEnabled: false, effectiveEnabled: false });
    expect(store.coding_plan_monthly_refresh_enabled).toBe(false);
  });

  it('fail-closed: rejects when disabled_at is in the future (cross-pod clock skew)', async () => {
    // 跨 Pod 时钟回退→未来时间戳(elapsed<0)：fail-closed 一律拒，不重开 P1 窗口。
    const future = new Date(Date.now() + 20_000).toISOString();
    const { controller, store } = buildSwitchController({
      coding_plan_monthly_refresh_enabled: true,
      selfop_negative_deduct_enabled: false,
      selfop_negative_deduct_disabled_at: future,
    });
    await expect(controller.setCodingPlanMonthlyRefresh({ enabled: false })).rejects.toThrow(/收敛/);
    expect(store.coding_plan_monthly_refresh_enabled).toBe(true);
  });

  it('fail-closed: rejects when disabled_at is corrupted (NaN)', async () => {
    const { controller, store } = buildSwitchController({
      coding_plan_monthly_refresh_enabled: true,
      selfop_negative_deduct_enabled: false,
      selfop_negative_deduct_disabled_at: 'not-a-date',
    });
    await expect(controller.setCodingPlanMonthlyRefresh({ enabled: false })).rejects.toThrow(/收敛/);
    expect(store.coding_plan_monthly_refresh_enabled).toBe(true);
  });

  it('re-enabling negative deduct clears disabled_at (resets convergence timer)', async () => {
    // 开负额写 null 清零：下次关闭重新计时，不残留旧时间戳误判。
    const { controller, store } = buildSwitchController({
      coding_plan_monthly_refresh_enabled: true,
      selfop_negative_deduct_enabled: false,
      selfop_negative_deduct_disabled_at: new Date(Date.now() - 46_000).toISOString(),
    });
    await controller.setSelfopNegativeDeduct({ enabled: true });
    expect(store.selfop_negative_deduct_disabled_at).toBeNull();
  });

  it('rejects non-boolean payloads on both switches', async () => {
    const { controller } = buildSwitchController();
    await expect(controller.setSelfopNegativeDeduct({ enabled: 'yes' })).rejects.toThrow(/boolean/);
    await expect(controller.setCodingPlanMonthlyRefresh({})).rejects.toThrow(/boolean/);
  });

  it('GET exposes env/admin/effective plus gateway env for diagnostics', async () => {
    process.env.BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE = 'true';
    try {
      const { controller } = buildSwitchController({ selfop_negative_deduct_enabled: true });
      const res = await controller.getSelfopNegativeDeduct();
      expect(res.data).toMatchObject({
        adminEnabled: true,
        effectiveEnabled: true,
        envForced: false,
        gatewayNegativeEnv: true,
      });
    } finally {
      delete process.env.BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE;
    }
  });
});
