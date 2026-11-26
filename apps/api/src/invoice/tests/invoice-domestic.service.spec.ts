import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ProductBillingMode } from '@prisma/client';
import { InvoiceDomesticService } from '../invoice-domestic.service';
import { InvoiceNothingToInvoiceError } from '../invoice.errors';
import { InvoicePeriodSourceRow } from '../invoice-source.service';

interface PeriodRow extends Partial<InvoicePeriodSourceRow> {
  user_id?: string;
  tenant_id?: string;
  billing_account_id?: string;
  period: string;
  orderId: string;
  currency?: string;
  orderAmountCents?: number;
  periodConsumedPrincipalCents?: number;
  totalConsumedPrincipalCents?: number;
  recordCount?: number;
}

interface OrderRow {
  id: string;
  userId?: string;
  tenantId?: string;
  orderType?: 'SUBSCRIPTION' | 'BOOSTER_PACK' | 'RECHARGE' | 'BUNDLE';
  amountCents?: number;
  bonusCents?: number;
  currency?: string;
  status?: 'PENDING' | 'PAID' | 'FULFILLING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';
  refundedAt?: Date | null;
  paidAt?: Date | null;
  createdAt?: Date;
  productId?: string | null;
  product?: { name: string; billingMode: ProductBillingMode } | null;
  plan?: {
    name: string;
    product: { name: string; billingMode: ProductBillingMode };
  } | null;
  boosterPack?: { name: string } | null;
  bundleSku?: { name: string } | null;
  items?: Array<{
    name: string;
    amountCents: number;
    currency: string;
    productId: string | null;
    planId: string | null;
    boosterPackId: string | null;
    product: { name: string; billingMode: ProductBillingMode } | null;
    plan: {
      name: string;
      product: { name: string; billingMode: ProductBillingMode } | null;
    } | null;
    boosterPack: {
      name: string;
      product: { name: string; billingMode: ProductBillingMode } | null;
    } | null;
  }>;
}

function buildHarness(rows: PeriodRow[], orderRows: OrderRow[] = []) {
  const now = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const orders = orderRows.map((order) => ({
    userId: 'user-1',
    tenantId: 'tenant-1',
    orderType: 'SUBSCRIPTION',
    amountCents: 12_000,
    bonusCents: 0,
    currency: 'cny',
    status: 'PAID',
    refundedAt: null,
    paidAt: now,
    createdAt: now,
    productId: null,
    product: null,
    plan: null,
    boosterPack: null,
    bundleSku: null,
    items: [],
    ...order,
  }));
  const applications: Array<{
    id: string;
    userId: string;
    tenantId: string;
    status: string;
    subtotalCents: number;
    totalCents: number;
    currency: string;
    items: Array<{
      id: string;
      orderId: string;
      principalCents: number;
      serviceStart: Date | null;
      serviceEnd: Date | null;
      productName: string | null;
      description?: string;
    }>;
  }> = [];
  const invoiceItems: Array<{
    orderId: string;
    principalCents: number;
    status: string;
    serviceStart: Date | null;
  }> = [];
  const events: Array<{ applicationId: string; toStatus: string; metadata?: unknown }> = [];
  const idempotency = new Map<string, unknown>();

  const prisma: Record<string, unknown> = {};
  Object.assign(prisma, {
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, userId?: string, tenantId?: string) =>
      rows.filter((row) => {
        if (row.user_id && row.user_id !== userId) return false;
        if (row.tenant_id && row.tenant_id !== tenantId) return false;
        return true;
      }),
    ),
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback(prisma)),
    invoiceApplicationItem: {
      aggregate: jest.fn(async ({ where }: { where: { orderId: string; application: { status: { in: string[] } } } }) => {
        const sum = invoiceItems
          .filter((item) => item.orderId === where.orderId)
          .filter((item) => where.application.status.in.includes(item.status))
          .reduce((total, item) => total + item.principalCents, 0);
        return { _sum: { principalCents: sum } };
      }),
      groupBy: jest.fn(async ({ where }: { where: { orderId: { in: string[] }; application: { status: { in: string[] } } } }) => {
        const grouped = new Map<string, number>();
        for (const item of invoiceItems) {
          if (!where.orderId.in.includes(item.orderId)) continue;
          if (!where.application.status.in.includes(item.status)) continue;
          grouped.set(item.orderId, (grouped.get(item.orderId) ?? 0) + item.principalCents);
        }
        return [...grouped.entries()].map(([orderId, sum]) => ({
          orderId,
          _sum: { principalCents: sum },
        }));
      }),
      findMany: jest.fn(async ({ where }: { where: { orderId: { in: string[] }; application: { status: { in: string[] } } } }) =>
        invoiceItems
          .filter((item) => where.orderId.in.includes(item.orderId))
          .filter((item) => where.application.status.in.includes(item.status))
          .filter((item) => item.serviceStart !== null)
          .map((item) => ({
            orderId: item.orderId,
            principalCents: item.principalCents,
            serviceStart: item.serviceStart,
          })),
      ),
    },
    invoiceApplication: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const application = applications.find((item) => item.id === where.id);
        if (!application) return null;
        return {
          userId: application.userId,
          tenantId: application.tenantId,
          items: application.items.map((item) => ({
            description: item.description,
            serviceStart: item.serviceStart,
            order: {
              billingAccountId: rows.find((row) => row.orderId === item.orderId)
                ?.billing_account_id ?? `ba-${application.userId}`,
            },
          })),
        };
      }),
      create: jest.fn(async ({ data }: { data: {
        userId: string;
        tenantId: string;
        currency: string;
        subtotalCents: number;
        totalCents: number;
        status: string;
        items: { createMany: { data: Array<{
          orderId: string;
          principalCents: number;
          serviceStart: Date;
          serviceEnd: Date;
          productName: string | null;
          description?: string;
        }> } };
      } }) => {
        const app = {
          id: `app-${applications.length + 1}`,
          userId: data.userId,
          tenantId: data.tenantId,
          status: data.status,
          subtotalCents: data.subtotalCents,
          totalCents: data.totalCents,
          currency: data.currency,
          items: data.items.createMany.data.map((item, index) => ({
            id: `item-${applications.length + 1}-${index + 1}`,
            ...item,
          })),
        };
        applications.push(app);
        for (const item of app.items) {
          invoiceItems.push({
            orderId: item.orderId,
            principalCents: item.principalCents,
            status: data.status,
            serviceStart: item.serviceStart,
          });
        }
        return app;
      }),
    },
    invoiceEventLog: {
      create: jest.fn(async ({ data }: { data: { applicationId: string; toStatus: string; metadata?: unknown } }) => {
        events.push(data);
      }),
    },
    idempotencyKey: {
      findUnique: jest.fn(async ({ where }: { where: { key_scope: { key: string; scope: string } } }) => {
        const result = idempotency.get(`${where.key_scope.scope}:${where.key_scope.key}`);
        return result ? { result } : null;
      }),
      create: jest.fn(async ({ data }: { data: { key: string; scope: string; result: unknown } }) => {
        idempotency.set(`${data.scope}:${data.key}`, data.result);
      }),
    },
  });

  const profileService = {
    requireOwnedProfile: jest.fn(async (userId: string, tenantId: string, id: string) => ({
      id,
      userId,
      tenantId,
      kind: 'ENTERPRISE',
      invoiceType: 'VAT_NORMAL',
      title: '上海睿动科技有限公司',
      taxNo: '91310000TEST',
      bankName: null,
      bankAccount: null,
      registeredAddress: null,
      registeredPhone: null,
      recipientName: null,
      recipientEmail: 'finance@example.com',
      recipientPhone: null,
      recipientAddress: null,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    })),
  };
  const eventService = {
    record: jest.fn(async (input: { applicationId: string; toStatus: string; metadata?: unknown }) => {
      events.push(input);
    }),
  };
  const billingService = {
    resolveSubjectForUserWithDb: jest.fn(async (
      _db: unknown,
      userId: string,
      tenantId: string,
    ) => ({
      userId,
      tenantId,
      billingAccountId: `ba-${userId}`,
    })),
  };
  const sourceService = {
    listInvoiceableOrders: jest.fn(async ({
      userId,
      tenantId,
      paidBefore,
    }: {
      userId: string;
      tenantId: string;
      paidBefore?: Date;
    }) =>
      orders
        .filter((order) => order.userId === userId && order.tenantId === tenantId)
        .filter((order) => order.refundedAt === null)
        .filter((order) => order.amountCents > 0)
        .filter((order) => ['PAID', 'FULFILLING', 'COMPLETED'].includes(order.status))
        .filter((order) => order.paidAt && order.paidAt <= (paidBefore ?? new Date(Date.now() - 24 * 60 * 60 * 1000))),
    ),
    findOrdersByIds: jest.fn(async ({
      userId,
      tenantId,
      orderIds,
    }: {
      userId: string;
      tenantId: string;
      orderIds: string[];
    }) =>
      orders
        .filter((order) => order.userId === userId && order.tenantId === tenantId)
        .filter((order) => orderIds.includes(order.id)),
    ),
    computeBasesForOrders: jest.fn(async (inputOrders: typeof orders) => new Map(
      inputOrders.map((order) => [
        order.id,
        {
          baseCents: order.orderType === 'RECHARGE'
            ? 0
            : order.items.length > 0
              ? order.items
                .filter((item) =>
                  item.product?.billingMode === ProductBillingMode.CODING_PLAN
                  || item.plan?.product?.billingMode === ProductBillingMode.CODING_PLAN
                  || item.boosterPack?.product?.billingMode === ProductBillingMode.CODING_PLAN,
                )
                .reduce((sum, item) => sum + item.amountCents, 0)
              : order.amountCents,
          consumedPrincipalCents: order.orderType === 'RECHARGE' ? 0 : order.amountCents,
        },
      ]),
    )),
    computeBaseForOrder: jest.fn(async (order: typeof orders[number]) => ({
      baseCents: order.orderType === 'RECHARGE' ? 0 : order.amountCents,
      consumedPrincipalCents: order.orderType === 'RECHARGE' ? 0 : order.amountCents,
    })),
    listDomesticPeriodRows: jest.fn(async ({
      billingAccountId,
    }: {
      userId: string;
      tenantId: string;
      billingAccountId: string;
    }) =>
      rows
        .filter((row) => {
          if (row.billing_account_id && row.billing_account_id !== billingAccountId) return false;
          return true;
        })
        .map((row): InvoicePeriodSourceRow => ({
          period: row.period,
          orderId: row.orderId,
          orderType: row.orderType ?? 'RECHARGE',
          currency: row.currency ?? 'cny',
          orderAmountCents: row.orderAmountCents ?? 0,
          totalBaseCents: row.totalBaseCents ?? Math.min(
            row.orderAmountCents ?? 0,
            row.totalConsumedPrincipalCents ?? 0,
          ),
          periodConsumedPrincipalCents: row.periodConsumedPrincipalCents ?? 0,
          totalConsumedPrincipalCents: row.totalConsumedPrincipalCents ?? 0,
          recordCount: row.recordCount ?? 1,
          productName: row.productName ?? 'API 按量用量',
          description: row.description ?? 'RAYTONE_API',
        })),
    ),
  };

  return {
    service: new InvoiceDomesticService(
      prisma as never,
      billingService as never,
      profileService as never,
      eventService as never,
      sourceService as never,
    ),
    prisma,
    billingService,
    profileService,
    eventService,
    sourceService,
    applications,
    invoiceItems,
    events,
    orders,
  };
}

describe('InvoiceDomesticService — 国内月账期开票', () => {
  it('按月汇总可开票账期，并扣除同账期已占用金额', async () => {
    const { service, invoiceItems } = buildHarness([
      {
        period: '2026-05',
        orderId: 'order-1',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 8_000,
        recordCount: 2,
      },
      {
        period: '2026-05',
        orderId: 'order-2',
        currency: 'cny',
        orderAmountCents: 20_000,
        periodConsumedPrincipalCents: 2_000,
        totalConsumedPrincipalCents: 2_000,
        recordCount: 1,
      },
    ]);
    invoiceItems.push({
      orderId: 'order-1',
      principalCents: 1_000,
      status: 'PENDING_REVIEW',
      serviceStart: new Date(Date.UTC(2026, 4, 1) - 8 * 60 * 60 * 1000),
    });

    const periods = await service.listInvoiceablePeriods({
      userId: 'user-1',
      tenantId: 'tenant-1',
      year: 2026,
      month: 5,
    });

    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      period: '2026-05',
      consumedPrincipalCents: 5_000,
      occupiedInvoiceCents: 1_000,
      invoiceableCents: 4_000,
      recordCount: 3,
      status: 'invoiceable',
    });
  });

  it('按已授权账务账户汇总跨工作区消费，并在预览后新增 354 分占用时只补开 146 分', async () => {
    const {
      service,
      prisma,
      billingService,
      sourceService,
      invoiceItems,
      applications,
    } = buildHarness([
      {
        billing_account_id: 'ba-user-1',
        period: '2026-06',
        orderId: 'order-cross-workspace',
        currency: 'cny',
        orderAmountCents: 500,
        totalBaseCents: 500,
        periodConsumedPrincipalCents: 500,
        totalConsumedPrincipalCents: 500,
        recordCount: 1_053,
      },
    ]);
    const periods = await service.listInvoiceablePeriods({
      userId: 'user-1',
      tenantId: 'tenant-personal',
      year: 2026,
      month: 6,
    });

    expect(periods).toEqual([
      expect.objectContaining({
        period: '2026-06',
        consumedPrincipalCents: 500,
        occupiedInvoiceCents: 0,
        invoiceableCents: 500,
        recordCount: 1_053,
      }),
    ]);
    expect(billingService.resolveSubjectForUserWithDb).toHaveBeenCalledWith(
      prisma,
      'user-1',
      'tenant-personal',
      {
        requireBillingRole: true,
        requireExplicitTenant: true,
        requireProvisionedBillingAccount: true,
      },
    );
    expect(sourceService.listDomesticPeriodRows).toHaveBeenCalledWith(
      expect.objectContaining({ billingAccountId: 'ba-user-1' }),
    );

    invoiceItems.push({
      orderId: 'order-cross-workspace',
      principalCents: 354,
      status: 'PENDING_REVIEW',
      serviceStart: new Date('2026-05-31T16:00:00.000Z'),
    });
    const afterOccupied = await service.listInvoiceablePeriods({
      userId: 'user-1',
      tenantId: 'tenant-personal',
      year: 2026,
      month: 6,
    });
    expect(afterOccupied[0]).toMatchObject({
      consumedPrincipalCents: 500,
      occupiedInvoiceCents: 354,
      invoiceableCents: 146,
    });

    await service.submitPeriodApplication({
      userId: 'user-1',
      tenantId: 'tenant-personal',
      profileId: 'profile-1',
      period: '2026-06',
      idempotencyKey: 'idem-cross-workspace-balance',
    });

    expect(applications).toHaveLength(1);
    expect(applications[0]?.items).toEqual([
      expect.objectContaining({
        orderId: 'order-cross-workspace',
        principalCents: 146,
      }),
    ]);
  });

  it('国内账期同时汇总充值消耗和其它已付款账单', async () => {
    const { service } = buildHarness([
      {
        period: '2026-05',
        orderId: 'recharge-order',
        orderType: 'RECHARGE',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 3_000,
        recordCount: 2,
        productName: 'API 按量用量',
        description: 'RAYTONE_API',
      },
      {
        period: '2026-05',
        orderId: 'subscription-order',
        orderType: 'SUBSCRIPTION',
        currency: 'cny',
        orderAmountCents: 12_000,
        totalBaseCents: 12_000,
        periodConsumedPrincipalCents: 12_000,
        totalConsumedPrincipalCents: 12_000,
        recordCount: 1,
        productName: '企业订阅',
        description: 'RAYTONE_API',
      },
    ]);

    const periods = await service.listInvoiceablePeriods({
      userId: 'user-1',
      tenantId: 'tenant-1',
      year: 2026,
      month: 5,
    });

    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      period: '2026-05',
      consumedPrincipalCents: 15_000,
      invoiceableCents: 15_000,
      recordCount: 3,
      status: 'invoiceable',
    });
  });

  it('国内月账期固定排除 TokenPlan 来源', async () => {
    const { service } = buildHarness([
      {
        period: '2026-05',
        orderId: 'api-order',
        orderType: 'RECHARGE',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 3_000,
        recordCount: 2,
        productName: 'API 按量用量',
        description: 'RAYTONE_API',
      },
      {
        period: '2026-05',
        orderId: 'tokenplan-order',
        orderType: 'SUBSCRIPTION',
        currency: 'cny',
        orderAmountCents: 12_000,
        totalBaseCents: 12_000,
        periodConsumedPrincipalCents: 12_000,
        totalConsumedPrincipalCents: 12_000,
        recordCount: 1,
        productName: 'TokenPlan Pro',
        description: 'TOKEN_PLAN',
      },
    ]);

    const periods = await service.listInvoiceablePeriods({
      userId: 'user-1',
      tenantId: 'tenant-1',
      year: 2026,
      month: 5,
    });

    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      period: '2026-05',
      consumedPrincipalCents: 3_000,
      invoiceableCents: 3_000,
      recordCount: 2,
      status: 'invoiceable',
    });
  });

  it('国内月账期拒绝 TokenPlan 来源，订阅类需要按订单开票', async () => {
    const { service } = buildHarness([]);

    await expect(
      service.listInvoiceablePeriods({
        userId: 'user-1',
        tenantId: 'tenant-1',
        year: 2026,
        month: 5,
        description: 'TOKEN_PLAN',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('提交月账期申请只创建待审核申请，不触发海外自动出票', async () => {
    const { service, applications, events, eventService } = buildHarness([
      {
        period: '2026-05',
        orderId: 'order-1',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 8_000,
        recordCount: 2,
      },
    ]);

    const app = await service.submitPeriodApplication({
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      period: '2026-05',
      idempotencyKey: 'idem-period-1',
      description: 'RAYTONE_API',
    });

    expect(app).toMatchObject({
      status: 'PENDING_REVIEW',
      subtotalCents: 3_000,
      totalCents: 3_000,
      currency: 'cny',
    });
    const created = app as typeof app & { items: typeof applications[number]['items'] };
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({
      orderId: 'order-1',
      principalCents: 3_000,
      productName: 'API 按量用量',
    });
    const serviceStart = created.items[0].serviceStart;
    const serviceEnd = created.items[0].serviceEnd;
    expect(serviceStart).toBeInstanceOf(Date);
    expect(serviceEnd).toBeInstanceOf(Date);
    expect(serviceStart?.toISOString()).toBe('2026-04-30T16:00:00.000Z');
    expect(serviceEnd?.toISOString()).toBe('2026-05-31T15:59:59.999Z');
    expect(applications).toHaveLength(1);
    expect(eventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'PENDING_REVIEW',
        metadata: {
          period: '2026-05',
          deployment: 'domestic',
          billingAccountId: 'ba-user-1',
        },
      }),
      expect.anything(),
    );
    expect(events.some((event) => event.toStatus === 'ISSUED')).toBe(false);
  });

  it('提交国内 TokenPlan 账期申请时拒绝，避免订阅类套用账期概念', async () => {
    const { service } = buildHarness([
      {
        period: '2026-05',
        orderId: 'api-order',
        orderType: 'RECHARGE',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 3_000,
        recordCount: 2,
        productName: 'API 按量用量',
        description: 'RAYTONE_API',
      },
      {
        period: '2026-05',
        orderId: 'tokenplan-order',
        orderType: 'SUBSCRIPTION',
        currency: 'cny',
        orderAmountCents: 12_000,
        totalBaseCents: 12_000,
        periodConsumedPrincipalCents: 12_000,
        totalConsumedPrincipalCents: 12_000,
        recordCount: 1,
        productName: 'TokenPlan Pro',
        description: 'TOKEN_PLAN',
      },
    ]);

    await expect(
      service.submitPeriodApplication({
        userId: 'user-1',
        tenantId: 'tenant-1',
        profileId: 'profile-1',
        period: '2026-05',
        idempotencyKey: 'idem-tokenplan-period',
        description: 'TOKEN_PLAN',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('幂等键命中时回放已有申请，不重复创建', async () => {
    const { service, applications } = buildHarness([
      {
        period: '2026-05',
        orderId: 'order-1',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 8_000,
        recordCount: 2,
      },
    ]);

    const first = await service.submitPeriodApplication({
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      period: '2026-05',
      idempotencyKey: 'idem-period-dup',
    });
    const second = await service.submitPeriodApplication({
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      period: '2026-05',
      idempotencyKey: 'idem-period-dup',
    });

    expect(second).toEqual(first);
    expect(applications).toHaveLength(1);
  });

  it('幂等回放前重新校验账务 owner 权限，权限撤销后不返回缓存申请', async () => {
    const { service, billingService, applications } = buildHarness([
      {
        period: '2026-05',
        orderId: 'order-1',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 8_000,
        recordCount: 2,
      },
    ]);
    const input = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      period: '2026-05',
      idempotencyKey: 'idem-period-revoked-owner',
    };

    await service.submitPeriodApplication(input);
    billingService.resolveSubjectForUserWithDb.mockRejectedValueOnce(
      new ForbiddenException('无权访问该团队账务'),
    );

    await expect(service.submitPeriodApplication(input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(applications).toHaveLength(1);
  });

  it('工作区改绑账务账户后拒绝回放旧账户的幂等申请', async () => {
    const { service, billingService, applications } = buildHarness([
      {
        billing_account_id: 'ba-user-1',
        period: '2026-05',
        orderId: 'order-idempotency-account',
        currency: 'cny',
        orderAmountCents: 500,
        periodConsumedPrincipalCents: 500,
        totalConsumedPrincipalCents: 500,
        recordCount: 1,
      },
    ]);
    const input = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      period: '2026-05',
      idempotencyKey: 'idem-period-account-replay',
    };

    await service.submitPeriodApplication(input);
    billingService.resolveSubjectForUserWithDb.mockResolvedValueOnce({
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-rebound',
    });

    await expect(service.submitPeriodApplication(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(applications).toHaveLength(1);
  });

  it('预校验后工作区改绑到账务账户时终止申请，不跨账户创建发票', async () => {
    const { service, billingService, sourceService, applications } = buildHarness([
      {
        period: '2026-05',
        orderId: 'order-1',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 8_000,
        recordCount: 2,
      },
    ]);
    billingService.resolveSubjectForUserWithDb
      .mockResolvedValueOnce({
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-before',
      })
      .mockResolvedValueOnce({
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-after',
      });

    await expect(service.submitPeriodApplication({
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      period: '2026-05',
      idempotencyKey: 'idem-period-account-rebind',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(sourceService.listDomesticPeriodRows).not.toHaveBeenCalled();
    expect(applications).toHaveLength(0);
  });

  it('相同幂等键在不同用户下互不回放', async () => {
    const { service, applications } = buildHarness([
      {
        user_id: 'user-1',
        tenant_id: 'tenant-1',
        billing_account_id: 'ba-user-1',
        period: '2026-05',
        orderId: 'order-1',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 8_000,
        recordCount: 2,
      },
      {
        user_id: 'user-2',
        tenant_id: 'tenant-1',
        billing_account_id: 'ba-user-2',
        period: '2026-05',
        orderId: 'order-2',
        currency: 'cny',
        orderAmountCents: 10_000,
        periodConsumedPrincipalCents: 3_000,
        totalConsumedPrincipalCents: 8_000,
        recordCount: 2,
      },
    ]);

    await service.submitPeriodApplication({
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      period: '2026-05',
      idempotencyKey: 'idem-period-shared',
    });
    await service.submitPeriodApplication({
      userId: 'user-2',
      tenantId: 'tenant-1',
      profileId: 'profile-2',
      period: '2026-05',
      idempotencyKey: 'idem-period-shared',
    });

    expect(applications).toHaveLength(2);
  });

  it('没有可开票金额时拒绝提交', async () => {
    const { service } = buildHarness([]);

    await expect(
      service.submitPeriodApplication({
        userId: 'user-1',
        tenantId: 'tenant-1',
        profileId: 'profile-1',
        period: '2026-05',
        idempotencyKey: 'idem-empty',
      }),
    ).rejects.toBeInstanceOf(InvoiceNothingToInvoiceError);
  });

  it('未出账月份拒绝提交', async () => {
    const { service } = buildHarness([]);
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    const period = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}`;

    await expect(
      service.submitPeriodApplication({
        userId: 'user-1',
        tenantId: 'tenant-1',
        profileId: 'profile-1',
        period,
        idempotencyKey: 'idem-future',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('InvoiceDomesticService — 国内 TokenPlan 订单级开票', () => {
  it('刚支付的国内 TokenPlan 订单能立刻出现在可开票订单列表', async () => {
    const paidAt = new Date(Date.now() - 60 * 60 * 1000);
    const { service, sourceService } = buildHarness([], [
      {
        id: 'recent-tokenplan-order',
        orderType: 'SUBSCRIPTION',
        amountCents: 12_000,
        paidAt,
        productId: 'prod-token-plan',
        product: {
          name: 'TokenPlan Pro',
          billingMode: ProductBillingMode.CODING_PLAN,
        },
      },
    ]);

    const purchases = await service.listInvoiceablePurchases('user-1', 'tenant-1');

    expect(sourceService.listInvoiceableOrders).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-1',
      paidBefore: expect.any(Date),
    });
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      orderId: 'recent-tokenplan-order',
      paidAt,
      paidAmountCents: 12_000,
      invoiceableCents: 12_000,
      description: 'TOKEN_PLAN',
    });
  });

  it('已订阅的 TokenPlan 订单能出现在可开票订单列表', async () => {
    const { service, invoiceItems } = buildHarness([], [
      {
        id: 'tokenplan-order',
        orderType: 'SUBSCRIPTION',
        amountCents: 12_000,
        productId: 'prod-token-plan',
        product: {
          name: 'TokenPlan Pro',
          billingMode: ProductBillingMode.CODING_PLAN,
        },
      },
      {
        id: 'api-order',
        orderType: 'BOOSTER_PACK',
        amountCents: 8_000,
        productId: 'prod-api',
        product: {
          name: 'API Credits',
          billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        },
      },
    ]);
    invoiceItems.push({
      orderId: 'tokenplan-order',
      principalCents: 2_000,
      status: 'PENDING_REVIEW',
      serviceStart: null,
    });

    const purchases = await service.listInvoiceablePurchases('user-1', 'tenant-1');

    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      orderId: 'tokenplan-order',
      orderType: 'SUBSCRIPTION',
      paidAmountCents: 12_000,
      occupiedInvoiceCents: 2_000,
      invoiceableCents: 10_000,
      productId: 'prod-token-plan',
      productName: 'TokenPlan Pro',
      description: 'TOKEN_PLAN',
      status: 'PAID',
    });
  });

  it('提交国内 TokenPlan 订单级申请只创建待审核申请', async () => {
    const { service, applications, eventService, events } = buildHarness([], [
      {
        id: 'tokenplan-order',
        orderType: 'SUBSCRIPTION',
        amountCents: 12_000,
        product: {
          name: 'TokenPlan Pro',
          billingMode: ProductBillingMode.CODING_PLAN,
        },
      },
    ]);

    const app = await service.submitApplication({
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      items: [{ orderId: 'tokenplan-order' }],
      idempotencyKey: 'idem-tokenplan-order',
    });

    expect(app).toMatchObject({
      status: 'PENDING_REVIEW',
      subtotalCents: 12_000,
      totalCents: 12_000,
      currency: 'cny',
    });
    const created = app as typeof app & {
      items: Array<{
        orderId: string;
        principalCents: number;
        description: string;
        productName: string | null;
        serviceStart: Date | null;
        serviceEnd: Date | null;
      }>;
    };
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({
      orderId: 'tokenplan-order',
      principalCents: 12_000,
      description: 'TOKEN_PLAN',
      productName: 'TokenPlan Pro',
      serviceStart: null,
      serviceEnd: null,
    });
    expect(applications).toHaveLength(1);
    expect(eventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'PENDING_REVIEW',
        metadata: { deployment: 'domestic', source: 'TOKEN_PLAN' },
      }),
      expect.anything(),
    );
    expect(events.some((event) => event.toStatus === 'ISSUED')).toBe(false);
  });

  it('刚支付的国内 TokenPlan 订单可以立刻提交开票申请', async () => {
    const { service } = buildHarness([], [
      {
        id: 'recent-tokenplan-order',
        orderType: 'SUBSCRIPTION',
        amountCents: 12_000,
        paidAt: new Date(Date.now() - 60 * 60 * 1000),
        product: {
          name: 'TokenPlan Pro',
          billingMode: ProductBillingMode.CODING_PLAN,
        },
      },
    ]);

    const app = await service.submitApplication({
      userId: 'user-1',
      tenantId: 'tenant-1',
      profileId: 'profile-1',
      items: [{ orderId: 'recent-tokenplan-order' }],
      idempotencyKey: 'idem-recent-tokenplan-order',
    });

    expect(app).toMatchObject({
      status: 'PENDING_REVIEW',
      subtotalCents: 12_000,
      totalCents: 12_000,
      currency: 'cny',
    });
  });

  it('国内普通订单绕过前端提交订单级申请时仍提示按月账期申请', async () => {
    const { service } = buildHarness([], [
      {
        id: 'api-order',
        orderType: 'BOOSTER_PACK',
        amountCents: 8_000,
        product: {
          name: 'API Credits',
          billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        },
      },
    ]);

    await expect(
      service.submitApplication({
        userId: 'user-1',
        tenantId: 'tenant-1',
        profileId: 'profile-1',
        items: [{ orderId: 'api-order' }],
        idempotencyKey: 'idem-api-order',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
