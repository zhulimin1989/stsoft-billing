import { Test } from '@nestjs/testing';
import { Prisma, ProductBillingMode } from '@prisma/client';
import { InvoiceApplicationService } from '../invoice-application.service';
import { InvoiceInternationalService } from '../invoice-international.service';
import { InvoiceStorageService } from '../invoice-storage.service';
import { InvoiceProfileService } from '../invoice-profile.service';
import { InvoiceEventService } from '../invoice-event.service';
import { InvoiceSourceService } from '../invoice-source.service';
import { InvoiceDeploymentService } from '../invoice-deployment.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InvoiceCurrencyMismatchError,
  InvoiceInvalidUploadedFileError,
  InvoiceInvalidStateTransitionError,
  InvoiceNothingToInvoiceError,
  InvoiceNumberAlreadyUsedError,
} from '../invoice.errors';


function matchesInvoiceNumber(
  stored: string | null | undefined,
  where: string | { equals?: string; mode?: string } | undefined,
) {
  if (where === undefined) return true;
  const expected = typeof where === 'string' ? where : where.equals;
  if (!expected) return true;
  return (stored ?? '').trim().replace(/\s+/g, '').toLowerCase()
    === expected.trim().replace(/\s+/g, '').toLowerCase();
}

function decimal(v: number | string) {
  return new Prisma.Decimal(v);
}

interface FakeOrder {
  id: string;
  userId: string;
  tenantId: string;
  orderType: 'SUBSCRIPTION' | 'BOOSTER_PACK' | 'RECHARGE' | 'BUNDLE';
  amountCents: number;
  bonusCents: number;
  currency: string;
  status: 'PENDING' | 'PAID' | 'FULFILLING' | 'COMPLETED' | 'REFUNDED' | 'FAILED';
  refundedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  productId: string | null;
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

function makeOrder(input: Partial<FakeOrder> & Pick<FakeOrder, 'id' | 'userId' | 'tenantId'>): FakeOrder {
  return {
    orderType: 'RECHARGE',
    amountCents: 1000,
    bonusCents: 0,
    currency: 'usd',
    status: 'PAID',
    refundedAt: null,
    paidAt: PAID_OLD,
    createdAt: PAID_OLD,
    productId: null,
    product: null,
    plan: null,
    boosterPack: null,
    bundleSku: null,
    items: [],
    ...input,
  };
}

function buildFakes() {
  const orders = new Map<string, FakeOrder>();
  const allocationsByOrderUsd = new Map<string, number>();
  const items: Array<{
    id?: string;
    applicationId?: string;
    orderId: string;
    principalCents: number;
    description?: string;
    productName?: string | null;
    serviceStart?: Date | null;
    serviceEnd?: Date | null;
    poNumber?: string | null;
    status: string;
  }> = [];
  const applications: Array<{
    id: string;
    status: string;
    userId: string;
    tenantId: string;
    applicationNo?: string;
    invoiceNumber?: string | null;
    currency?: string;
    subtotalCents: number;
    taxAmountCents?: number;
    totalCents?: number;
    profileId?: string | null;
    profileSnapshot?: unknown;
    items: Array<unknown>;
    pdfUrl?: string | null;
    failedReason?: string | null;
    voidReason?: string | null;
    psaStatus?: string;
    psaFormNo?: string | null;
    psaLastError?: string | null;
    psaAttemptCount?: number;
    psaLastAttemptAt?: Date | null;
  }> = [];
  const events: Array<{ applicationId: string; fromStatus: string | null; toStatus: string }> = [];
  const idempotency = new Map<string, unknown>();

  const prisma: Record<string, unknown> = {} as Record<string, unknown>;
  const decorateItem = (item: unknown) => {
    const row = item as {
      id?: string;
      orderId: string;
      principalCents: number;
      description?: string;
      productName?: string | null;
      serviceStart?: Date | null;
      serviceEnd?: Date | null;
      poNumber?: string | null;
      createdAt?: Date;
      order?: FakeOrder;
    };
    return {
      id: row.id,
      orderId: row.orderId,
      principalCents: row.principalCents,
      description: row.description,
      productName: row.productName ?? null,
      serviceStart: row.serviceStart ?? null,
      serviceEnd: row.serviceEnd ?? null,
      poNumber: row.poNumber ?? null,
      createdAt: row.createdAt ?? new Date(Date.now() - 48 * 60 * 60 * 1000),
      order: row.order ?? orders.get(row.orderId),
    };
  };
  const decorateApplication = (app: typeof applications[number]) => ({
    ...app,
    applicationNo: app.applicationNo ?? app.id,
    invoiceNumber: app.invoiceNumber ?? null,
    currency: app.currency ?? 'usd',
    taxAmountCents: app.taxAmountCents ?? 0,
    totalCents: app.totalCents ?? app.subtotalCents,
    profileId: app.profileId ?? 'p1',
    profileSnapshot: app.profileSnapshot ?? {},
    failedReason: app.failedReason ?? null,
    pdfUrl: app.pdfUrl ?? null,
    voidReason: app.voidReason ?? null,
    items: app.items.map(decorateItem),
  });
  Object.assign(prisma, {
    order: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return [...orders.values()].filter((o) => {
          if (where.userId && o.userId !== where.userId) return false;
          if (where.tenantId && o.tenantId !== where.tenantId) return false;
          if (where.refundedAt === null && o.refundedAt !== null) return false;
          if (where.amountCents && typeof where.amountCents === 'object') {
            const gt = (where.amountCents as { gt?: number }).gt;
            if (gt !== undefined && !(o.amountCents > gt)) return false;
          }
          if (where.paidAt && typeof where.paidAt === 'object') {
            const paidAt = where.paidAt as { gte?: Date; lt?: Date; lte?: Date };
            if (!o.paidAt) return false;
            if (paidAt.gte && o.paidAt < paidAt.gte) return false;
            if (paidAt.lt && o.paidAt >= paidAt.lt) return false;
            if (paidAt.lte && o.paidAt > paidAt.lte) return false;
          }
          if (where.orderType && typeof where.orderType === 'object') {
            const not = (where.orderType as { not?: string }).not;
            if (not && o.orderType === not) return false;
          } else if (where.orderType && o.orderType !== where.orderType) {
            return false;
          }
          if (where.status && typeof where.status === 'object') {
            const st = (where.status as { in: string[] }).in;
            if (!st.includes(o.status)) return false;
          }
          if (where.id && typeof where.id === 'object') {
            const ids = (where.id as { in: string[] }).in;
            if (!ids.includes(o.id)) return false;
          }
          return true;
        });
      }),
    },
    invoiceApplicationItem: {
      findMany: jest.fn(async ({ where }: { where: { applicationId: string } }) => {
        const app = applications.find((a) => a.id === where.applicationId);
        return app?.items ?? [];
      }),
      updateMany: jest.fn(async ({ where, data }: {
        where: { applicationId: string; orderId: string };
        data: Record<string, unknown>;
      }) => {
        const item = items.find((i) => i.applicationId === where.applicationId && i.orderId === where.orderId);
        if (item) Object.assign(item, data);
        const app = applications.find((a) => a.id === where.applicationId);
        const appItem = app?.items.find((i) => (i as { orderId: string }).orderId === where.orderId);
        if (appItem) Object.assign(appItem, data);
        return { count: item ? 1 : 0 };
      }),
      update: jest.fn(async ({ where, data }: {
        where: { id: string };
        data: { principalCents?: number };
      }) => {
        const item = items.find((i) => i.id === where.id);
        if (!item) throw new Error('invoice item not found');
        Object.assign(item, data);
        const app = applications.find((a) => a.id === item.applicationId);
        const appItem = app?.items.find((i) => (i as { id?: string }).id === where.id);
        if (appItem) Object.assign(appItem, data);
        return item;
      }),
      aggregate: jest.fn(async ({ where }: { where: { orderId: string; application: { status: { in: string[] } } } }) => {
        const sum = items
          .filter((i) => i.orderId === where.orderId && where.application.status.in.includes(i.status))
          .reduce((s, i) => s + i.principalCents, 0);
        return { _sum: { principalCents: sum } };
      }),
      groupBy: jest.fn(async ({ where }: { where: { orderId: { in: string[] }; application: { status: { in: string[] } } } }) => {
        const grouped = new Map<string, number>();
        for (const i of items) {
          if (!where.orderId.in.includes(i.orderId)) continue;
          if (!where.application.status.in.includes(i.status)) continue;
          grouped.set(i.orderId, (grouped.get(i.orderId) ?? 0) + i.principalCents);
        }
        return [...grouped.entries()].map(([orderId, sum]) => ({
          orderId,
          _sum: { principalCents: sum },
        }));
      }),
      findFirst: jest.fn(async ({ where }: {
        where: {
          invoiceNumber?: string | { equals?: string; mode?: string };
          id?: { not: string };
          orderId?: { in: string[] };
          applicationId?: { not: string };
          application?: { status: { in: string[] } };
        };
      }) => {
        const item = items.find((i) => {
          if (where.invoiceNumber && !matchesInvoiceNumber((i as { invoiceNumber?: string }).invoiceNumber, where.invoiceNumber as string | { equals?: string; mode?: string })) return false;
          if (where.id?.not && i.id === where.id.not) return false;
          if (where.orderId?.in && !where.orderId.in.includes(i.orderId)) return false;
          if (where.applicationId?.not && i.applicationId === where.applicationId.not) return false;
          if (where.application?.status?.in && !where.application.status.in.includes(i.status)) return false;
          return true;
        });
        if (!item) return null;
        const app = applications.find((a) => a.id === item.applicationId);
        return {
          ...item,
          application: app ? { applicationNo: app.applicationNo ?? app.id, status: app.status } : null,
        };
      }),
    },
    invoiceApplication: {
      create: jest.fn(async ({ data }: {
        data: {
          applicationNo?: string;
          userId: string;
          tenantId: string;
          profileId?: string | null;
          profileSnapshot?: unknown;
          currency?: string;
          subtotalCents: number;
          taxAmountCents?: number;
          totalCents?: number;
          status: string;
          invoiceNumber?: string | null;
          idempotencyKey?: string | null;
          items: {
            createMany: {
              data: Array<{
                orderId: string;
                principalCents: number;
                description?: string;
                productName?: string | null;
                serviceStart?: Date | null;
                serviceEnd?: Date | null;
                poNumber?: string | null;
              }>;
            };
          };
        };
      }) => {
        const id = `app-${applications.length + 1}`;
        const appItems = data.items.createMany.data.map((it, index) => ({
          id: `item-${applications.length + 1}-${index + 1}`,
          orderId: it.orderId,
          principalCents: it.principalCents,
          description: it.description,
          productName: it.productName ?? null,
          serviceStart: it.serviceStart ?? null,
          serviceEnd: it.serviceEnd ?? null,
          poNumber: it.poNumber ?? null,
          createdAt: new Date(),
        }));
        const app = {
          id,
          applicationNo: data.applicationNo ?? id,
          invoiceNumber: data.invoiceNumber ?? null,
          status: data.status,
          userId: data.userId,
          tenantId: data.tenantId,
          profileId: data.profileId ?? 'p1',
          profileSnapshot: data.profileSnapshot ?? {},
          currency: data.currency ?? 'usd',
          subtotalCents: data.subtotalCents,
          taxAmountCents: data.taxAmountCents ?? 0,
          totalCents: data.totalCents ?? data.subtotalCents,
          failedReason: null,
          pdfUrl: null,
          voidReason: null,
          psaStatus: 'NOT_SUBMITTED',
          psaFormNo: null,
          psaLastError: null,
          psaAttemptCount: 0,
          items: appItems,
        };
        applications.push(app);
        for (const it of appItems) {
          items.push({
            id: it.id,
            applicationId: id,
            orderId: it.orderId,
            principalCents: it.principalCents,
            description: it.description,
            productName: it.productName,
            serviceStart: it.serviceStart,
            serviceEnd: it.serviceEnd,
            poNumber: it.poNumber,
            status: data.status,
          });
        }
        return decorateApplication(app);
      }),
      findMany: jest.fn(async ({ where, skip = 0, take }: {
        where: {
          id?: { in: string[] };
          userId?: string;
          tenantId?: string;
          status?: string | { in: string[] };
          items?: { some?: { description?: string; order?: { orderType?: string } } };
        };
        skip?: number;
        take?: number;
      }) => {
        const rows = applications.filter((app) => {
          if (where.id?.in && !where.id.in.includes(app.id)) return false;
          if (where.userId && app.userId !== where.userId) return false;
          if (where.tenantId && app.tenantId !== where.tenantId) return false;
          if (typeof where.status === 'string' && app.status !== where.status) return false;
          if (where.status && typeof where.status === 'object') {
            const statuses = (where.status as { in?: string[] }).in ?? [];
            if (!statuses.includes(app.status)) return false;
          }
          const description = where.items?.some?.description;
          if (description) {
            if (!app.items.some((item) => (item as { description?: string }).description === description)) {
              return false;
            }
          }
          const orderType = where.items?.some?.order?.orderType;
          if (orderType) {
            if (!app.items.some((item) => orders.get((item as { orderId: string }).orderId)?.orderType === orderType)) {
              return false;
            }
          }
          return true;
        });
        return rows
          .slice(skip, typeof take === 'number' ? skip + take : undefined)
          .map(decorateApplication);
      }),
      count: jest.fn(async ({ where }: {
        where: {
          userId?: string;
          tenantId?: string;
          status?: string;
          items?: { some?: { description?: string } };
        };
      }) => {
        return applications.filter((app) => {
          if (where.userId && app.userId !== where.userId) return false;
          if (where.tenantId && app.tenantId !== where.tenantId) return false;
          if (where.status && app.status !== where.status) return false;
          const description = where.items?.some?.description;
          if (description) {
            return app.items.some((item) => (item as { description?: string }).description === description);
          }
          return true;
        }).length;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const app = applications.find((a) => a.id === where.id);
        return app ? decorateApplication(app) : null;
      }),
      findFirst: jest.fn(async ({ where }: {
        where: {
          invoiceNumber?: string | { equals?: string; mode?: string };
          id?: { not?: string };
        };
      }) => {
        return applications.find((a) =>
          matchesInvoiceNumber(a.invoiceNumber, where.invoiceNumber)
          && (!where.id?.not || a.id !== where.id.not),
        ) ?? null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const app = applications.find((a) => a.id === where.id);
        if (!app) throw new Error('not found');
        Object.assign(app, data);
        if (typeof data.status === 'string') {
          for (const it of items.filter((i) => i.applicationId === app.id)) {
            it.status = data.status as string;
          }
        }
        return decorateApplication(app);
      }),
      updateMany: jest.fn(async ({ where, data }: {
        where: {
          id?: string;
          status?: string;
          psaStatus?: string | { in?: string[] };
          psaLastAttemptAt?: Date | { lt?: Date } | null;
          OR?: Array<Record<string, unknown>>;
        };
        data: Record<string, unknown>;
      }) => {
        const matches = (app: (typeof applications)[number], clause: Record<string, unknown>): boolean => {
          if (clause.id && app.id !== clause.id) return false;
          if (typeof clause.status === 'string' && app.status !== clause.status) return false;
          const psaStatus = app.psaStatus ?? 'NOT_SUBMITTED';
          if (typeof clause.psaStatus === 'string' && psaStatus !== clause.psaStatus) return false;
          const psaStatusIn = (clause.psaStatus as { in?: string[] } | undefined)?.in;
          if (psaStatusIn && !psaStatusIn.includes(psaStatus)) return false;
          if (Array.isArray(clause.OR)) {
            if (!clause.OR.some((item) => matches(app, item))) return false;
          }
          const lastAttempt = clause.psaLastAttemptAt as { lt?: Date } | Date | null | undefined;
          if (lastAttempt && typeof lastAttempt === 'object' && 'lt' in lastAttempt && lastAttempt.lt) {
            const actual = app.psaLastAttemptAt ?? null;
            if (!actual || !(actual < lastAttempt.lt)) return false;
          }
          if (Object.prototype.hasOwnProperty.call(clause, 'psaLastAttemptAt') && clause.psaLastAttemptAt === null) {
            if (app.psaLastAttemptAt != null) return false;
          }
          return true;
        };
        const matched = applications.filter((app) => matches(app, where as Record<string, unknown>));
        for (const app of matched) {
          const next = { ...data };
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object' && 'increment' in (value as { increment?: unknown })) {
              (next as Record<string, unknown>)[key] =
                Number((app as Record<string, unknown>)[key] ?? 0)
                + Number((value as { increment: number }).increment);
            }
          }
          Object.assign(app, next);
        }
        return { count: matched.length };
      }),
    },
    invoiceEventLog: {
      create: jest.fn(async ({ data }: { data: { applicationId: string; fromStatus: string | null; toStatus: string } }) => {
        events.push(data);
      }),
    },
    idempotencyKey: {
      findUnique: jest.fn(async ({ where }: { where: { key_scope: { key: string; scope: string } } }) => {
        const k = `${where.key_scope.scope}:${where.key_scope.key}`;
        const result = idempotency.get(k);
        return result ? { result } : null;
      }),
      create: jest.fn(async ({ data }: { data: { key: string; scope: string; result: unknown } }) => {
        idempotency.set(`${data.scope}:${data.key}`, data.result);
      }),
    },
    $transaction: jest.fn(async (callback: ((tx: unknown) => unknown) | unknown[]): Promise<unknown> => {
      if (typeof callback === 'function') return await callback(prisma);
      return await Promise.all(callback as Array<Promise<unknown>>);
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('balance_consumption_allocations') && sql.includes('GROUP BY')) {
        const orderIds = values[0] as { strings?: unknown; values?: unknown[] };
        const list = (orderIds as { values?: unknown[] }).values ?? [];
        return list.map((oid) => ({ order_id: oid, usd: decimal(allocationsByOrderUsd.get(oid as string) ?? 0) }));
      }
      const orderId = values[0] as string;
      return [{ usd: decimal(allocationsByOrderUsd.get(orderId) ?? 0) }];
    }),
  });

  return { prisma, orders, allocationsByOrderUsd, items, applications, events, idempotency };
}

async function buildService() {
  const fakes = buildFakes();
  const profileService = {
    requireOwnedProfile: jest.fn(async (userId: string, tenantId: string, id: string) => ({
      id,
      userId,
      tenantId,
      kind: 'ENTERPRISE',
      invoiceType: 'COMMERCIAL_HK',
      title: 'Acme HK',
      taxNo: 'HK123',
      bankName: null,
      bankAccount: null,
      registeredAddress: null,
      registeredPhone: null,
      recipientName: null,
      recipientEmail: null,
      recipientPhone: null,
      recipientAddress: null,
    })),
  };
  const m = await Test.createTestingModule({
    providers: [
      InvoiceInternationalService,
      InvoiceApplicationService,
      { provide: PrismaService, useValue: fakes.prisma },
      { provide: InvoiceProfileService, useValue: profileService },
      InvoiceEventService,
      InvoiceStorageService,
      InvoiceSourceService,
      {
        provide: InvoiceDeploymentService,
        useValue: {
          resolve: jest.fn(async () => 'international'),
          resolveLoginRegion: jest.fn(async () => 'international'),
        },
      },
    ],
  })
    .overrideProvider(InvoiceEventService)
    .useValue({ record: jest.fn(async () => undefined) })
    .overrideProvider(InvoiceStorageService)
    .useValue({
      persist: jest.fn(async (input: { applicationId: string; keyHint?: string; extension?: 'pdf' | 'ofd' }) => {
        const name = input.keyHint ?? input.applicationId;
        const extension = input.extension ?? 'pdf';
        return `invoices/u1/${name}.${extension}`;
      }),
      deleteObject: jest.fn(async () => undefined),
      readToBuffer: jest.fn(async () => Buffer.from('%PDF-test')),
      resolveForDownload: jest.fn(async (u: string) => ({
        kind: 's3' as const,
        url: `https://s3.test/${u}`,
      })),
    })
    .compile();
  return {
    service: m.get(InvoiceInternationalService),
    applicationService: m.get(InvoiceApplicationService),
    storageService: m.get(InvoiceStorageService),
    fakes,
    profileService,
  };
}

// 充值满 24h（可开票冷静期已过）的 paidAt；未明确测时间窗的用例统一用它。
const PAID_OLD = new Date(Date.now() - 48 * 60 * 60 * 1000);

describe('InvoiceService — 可开票计算', () => {
  it('refunded 订单 → 0', async () => {
    const { service } = await buildService();
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: new Date(),
      paidAt: PAID_OLD,
    });
    expect(result).toBe(0);
  });

  it('充值不足 24h → 0（冷静期）', async () => {
    const { service, fakes } = await buildService();
    fakes.allocationsByOrderUsd.set('o1', 10);
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: new Date(Date.now() - 60 * 60 * 1000), // 1h 前
    });
    expect(result).toBe(0);
  });

  it('订单状态 FAILED → 0', async () => {
    const { service } = await buildService();
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'FAILED' as never,
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(0);
  });

  it('amountCents <= 0 → 0', async () => {
    const { service } = await buildService();
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 0,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(0);
  });

  it('充值满 24h 后按订单实付金额全额可开', async () => {
    const { service, fakes } = await buildService();
    fakes.allocationsByOrderUsd.set('o1', 10); // $10 = 1000 cents
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(1000);
  });

  it('充值已消费不足订单金额 → 仍按订单实付金额可开', async () => {
    const { service, fakes } = await buildService();
    fakes.allocationsByOrderUsd.set('o1', 3); // $3 = 300 cents
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(1000);
  });

  it('充值未消费但已满 24h → 按订单实付金额可开', async () => {
    const { service } = await buildService();
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(1000);
  });

  it('可开票列表中充值未消费也按订单实付金额返回可开票金额', async () => {
    const { service, fakes } = await buildService();
    fakes.orders.set('o1', makeOrder({ id: 'o1', userId: 'u1', tenantId: 't1' }));

    const purchases = await service.listInvoiceablePurchases('u1', 't1');

    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      orderId: 'o1',
      orderType: 'RECHARGE',
      paidAmountCents: 1000,
      consumedPrincipalCents: 0,
      invoiceableCents: 1000,
      description: 'RAYTONE_API',
    });
  });

  it('已开 60% → 剩 40%', async () => {
    const { service, fakes } = await buildService();
    fakes.allocationsByOrderUsd.set('o1', 10);
    fakes.items.push({ orderId: 'o1', principalCents: 600, status: 'ISSUED' });
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(400);
  });

  it('REJECTED 占用不计', async () => {
    const { service, fakes } = await buildService();
    fakes.allocationsByOrderUsd.set('o1', 10);
    fakes.items.push({ orderId: 'o1', principalCents: 600, status: 'REJECTED' });
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(1000);
  });

  it('VOIDED / RED_OFFSET 占用不计，订单恢复可开票', async () => {
    const { service, fakes } = await buildService();
    fakes.allocationsByOrderUsd.set('o1', 10);
    fakes.items.push(
      { orderId: 'o1', principalCents: 600, status: 'VOIDED' },
      { orderId: 'o1', principalCents: 400, status: 'RED_OFFSET' },
    );
    const result = await service.computeInvoiceableForOrder({
      id: 'o1',
      amountCents: 1000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
    });
    expect(result).toBe(1000);
  });

  it('非充值付费订单按订单金额计算可开票金额', async () => {
    const { service } = await buildService();
    const result = await service.computeInvoiceableForOrder({
      id: 'coding-order',
      orderType: 'SUBSCRIPTION',
      amountCents: 12_000,
      currency: 'usd',
      status: 'PAID',
      refundedAt: null,
      paidAt: PAID_OLD,
      product: { name: 'TokenPlan Pro', billingMode: ProductBillingMode.CODING_PLAN },
    });
    expect(result).toBe(12_000);
  });

  it('可开票列表包含 TokenPlan 订单并带出产品描述', async () => {
    const { service, fakes } = await buildService();
    fakes.orders.set('coding-order', makeOrder({
      id: 'coding-order',
      userId: 'u1',
      tenantId: 't1',
      orderType: 'SUBSCRIPTION',
      amountCents: 12_000,
      productId: 'prod-coding',
      product: { name: 'TokenPlan Pro', billingMode: ProductBillingMode.CODING_PLAN },
    }));

    const purchases = await service.listInvoiceablePurchases('u1', 't1');

    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      orderId: 'coding-order',
      orderType: 'SUBSCRIPTION',
      paidAmountCents: 12_000,
      consumedPrincipalCents: 12_000,
      invoiceableCents: 12_000,
      productId: 'prod-coding',
      productName: 'TokenPlan Pro',
      description: 'TOKEN_PLAN',
    });
  });

  it('混合 Bundle 只按 TokenPlan 子项小计计算可开票金额', async () => {
    const { service, fakes } = await buildService();
    fakes.orders.set('bundle-order', makeOrder({
      id: 'bundle-order',
      userId: 'u1',
      tenantId: 't1',
      orderType: 'BUNDLE',
      amountCents: 20_000,
      productId: null,
      bundleSku: { name: '团队组合包' },
      items: [
        {
          name: 'TokenPlan Pro',
          amountCents: 12_000,
          currency: 'usd',
          productId: 'prod-token-plan',
          planId: 'plan-token-plan',
          boosterPackId: null,
          product: { name: 'TokenPlan', billingMode: ProductBillingMode.CODING_PLAN },
          plan: null,
          boosterPack: null,
        },
        {
          name: 'API Credits',
          amountCents: 8_000,
          currency: 'usd',
          productId: 'prod-api',
          planId: null,
          boosterPackId: 'booster-api',
          product: { name: 'Raytone API', billingMode: ProductBillingMode.PAY_AS_YOU_GO },
          plan: null,
          boosterPack: null,
        },
      ],
    }));

    const invoiceable = await service.computeInvoiceableForOrder(fakes.orders.get('bundle-order')!);
    const purchases = await service.listInvoiceablePurchases('u1', 't1');

    expect(invoiceable).toBe(12_000);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      orderId: 'bundle-order',
      orderType: 'BUNDLE',
      paidAmountCents: 20_000,
      consumedPrincipalCents: 12_000,
      invoiceableCents: 12_000,
      productName: 'TokenPlan Pro',
      description: 'TOKEN_PLAN',
    });
  });
});

describe('InvoiceService — submitApplication', () => {
  it('提交后保持 PENDING_REVIEW，不触发自动出票', async () => {
    const { service, fakes, storageService } = await buildService();
    fakes.orders.set('o1', makeOrder({
      id: 'o1',
      userId: 'u1',
      tenantId: 't1',
    }));
    fakes.allocationsByOrderUsd.set('o1', 10);

    const app = await service.submitApplication({
      userId: 'u1',
      tenantId: 't1',
      profileId: 'p1',
      items: [{ orderId: 'o1' }],
      idempotencyKey: 'idem-1',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.status).toBe('PENDING_REVIEW');
    expect(app.subtotalCents).toBe(1000);
    expect(storageService.persist).not.toHaveBeenCalled();
    expect(fakes.applications[0]).toMatchObject({
      status: 'PENDING_REVIEW',
      invoiceNumber: null,
      pdfUrl: null,
    });
  });

  it('幂等键命中 → 直接返回缓存', async () => {
    const { service, fakes } = await buildService();
    fakes.orders.set('o1', makeOrder({
      id: 'o1',
      userId: 'u1',
      tenantId: 't1',
    }));
    fakes.allocationsByOrderUsd.set('o1', 10);
    const a = await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }], idempotencyKey: 'idem-X',
    });
    const b = await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }], idempotencyKey: 'idem-X',
    });
    expect(b).toEqual(a);
  });

  it('多币种订单 → 抛 currency mismatch', async () => {
    const { service, fakes } = await buildService();
    fakes.orders.set('o1', makeOrder({ id: 'o1', userId: 'u1', tenantId: 't1' }));
    fakes.orders.set('o2', makeOrder({ id: 'o2', userId: 'u1', tenantId: 't1', amountCents: 500, currency: 'cny' }));
    fakes.allocationsByOrderUsd.set('o1', 10);
    fakes.allocationsByOrderUsd.set('o2', 5);
    await expect(
      service.submitApplication({
        userId: 'u1', tenantId: 't1', profileId: 'p1',
        items: [{ orderId: 'o1' }, { orderId: 'o2' }],
        idempotencyKey: 'idem-2',
      }),
    ).rejects.toBeInstanceOf(InvoiceCurrencyMismatchError);
  });

  it('订单可开金额已全部被占用 → 抛 nothing to invoice', async () => {
    const { service, fakes } = await buildService();
    fakes.orders.set('o1', makeOrder({ id: 'o1', userId: 'u1', tenantId: 't1' }));
    fakes.items.push({ orderId: 'o1', principalCents: 1000, status: 'ISSUED' });
    await expect(
      service.submitApplication({
        userId: 'u1', tenantId: 't1', profileId: 'p1',
        items: [{ orderId: 'o1' }],
        idempotencyKey: 'idem-3',
      }),
    ).rejects.toBeInstanceOf(InvoiceNothingToInvoiceError);
  });

  it('提交混合 Bundle 的 TokenPlan 发票时只冻结 TokenPlan 子项金额', async () => {
    const { service, fakes } = await buildService();
    fakes.orders.set('bundle-order', makeOrder({
      id: 'bundle-order',
      userId: 'u1',
      tenantId: 't1',
      orderType: 'BUNDLE',
      amountCents: 20_000,
      currency: 'usd',
      bundleSku: { name: '团队组合包' },
      items: [
        {
          name: 'TokenPlan Pro',
          amountCents: 12_000,
          currency: 'usd',
          productId: 'prod-token-plan',
          planId: 'plan-token-plan',
          boosterPackId: null,
          product: { name: 'TokenPlan', billingMode: ProductBillingMode.CODING_PLAN },
          plan: null,
          boosterPack: null,
        },
        {
          name: 'API Credits',
          amountCents: 8_000,
          currency: 'usd',
          productId: 'prod-api',
          planId: null,
          boosterPackId: 'booster-api',
          product: { name: 'Raytone API', billingMode: ProductBillingMode.PAY_AS_YOU_GO },
          plan: null,
          boosterPack: null,
        },
      ],
    }));

    const app = await service.submitApplication({
      userId: 'u1',
      tenantId: 't1',
      profileId: 'p1',
      items: [{ orderId: 'bundle-order' }],
      idempotencyKey: 'idem-bundle-token-plan',
    });

    expect(app.subtotalCents).toBe(12_000);
    expect(fakes.items).toContainEqual(expect.objectContaining({
      orderId: 'bundle-order',
      principalCents: 12_000,
    }));
  });
});

describe('InvoiceService — 状态转移', () => {
  async function setupWithApp(targetStatus: 'PENDING_REVIEW' | 'APPROVED_ISSUING' | 'ISSUED' = 'PENDING_REVIEW') {
    const harness = await buildService();
    const { fakes } = harness;
    fakes.orders.set('o1', makeOrder({ id: 'o1', userId: 'u1', tenantId: 't1' }));
    fakes.allocationsByOrderUsd.set('o1', 10);
    const app = await harness.service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }], idempotencyKey: `idem-${targetStatus}`,
    });
    if (targetStatus === 'APPROVED_ISSUING' || targetStatus === 'ISSUED') {
      await harness.applicationService.approveApplication(app.id, 'admin-1');
    }
    if (targetStatus === 'ISSUED') {
      await harness.applicationService.issueUploadedApplication({
        applicationId: app.id,
        adminId: 'admin-1',
        invoiceNumber: 'MANUAL-202606-001',
        issuingEntity: '102ISSHK',
        issueDate: new Date(Date.UTC(2026, 5, 23)),
        pdfFile: {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 test'),
        },
      });
    }
    return { ...harness, app };
  }

  it('用户取消 PENDING_REVIEW → CANCELLED', async () => {
    const { applicationService, app } = await setupWithApp('PENDING_REVIEW');
    const cancelled = await applicationService.cancelApplication('u1', 't1', app.id);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('用户取消 APPROVED_ISSUING → 拒', async () => {
    const { applicationService, app } = await setupWithApp('APPROVED_ISSUING');
    await expect(applicationService.cancelApplication('u1', 't1', app.id))
      .rejects.toBeInstanceOf(InvoiceInvalidStateTransitionError);
  });

  it('admin approve PENDING_REVIEW → APPROVED_ISSUING', async () => {
    const { applicationService, app } = await setupWithApp('PENDING_REVIEW');
    const approved = await applicationService.approveApplication(app.id, 'admin-1');
    expect(approved.status).toBe('APPROVED_ISSUING');
  });

  it('admin 人工上传国际票据 → ISSUED + 实际发票号写入', async () => {
    const { applicationService, app } = await setupWithApp('APPROVED_ISSUING');
    const issued = await applicationService.issueUploadedApplication({
      applicationId: app.id,
      adminId: 'admin-1',
      invoiceNumber: 'HK-202606-001',
      issuingEntity: '102ISSHK',
      issueDate: new Date(Date.UTC(2026, 5, 23)),
      pdfFile: {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 test'),
      },
    });
    expect(issued.status).toBe('ISSUED');
    expect(issued.invoiceNumber).toBe('HK-202606-001');
    expect(issued.dueDate).toBeNull();
  });

  it('多订单申请按明细分别上传，全部完成才变为已开票', async () => {
    const harness = await buildService();
    const { fakes, applicationService, service } = harness;
    fakes.orders.set('o1', makeOrder({ id: 'o1', userId: 'u1', tenantId: 't1', amountCents: 1000 }));
    fakes.orders.set('o2', makeOrder({ id: 'o2', userId: 'u1', tenantId: 't1', amountCents: 2000 }));
    fakes.allocationsByOrderUsd.set('o1', 10);
    fakes.allocationsByOrderUsd.set('o2', 20);
    const app = await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }, { orderId: 'o2' }],
      idempotencyKey: 'idem-multi-issue',
    });
    await applicationService.approveApplication(app.id, 'admin-1');
    const appItems = fakes.items.filter((item) => item.applicationId === app.id);
    const firstItem = appItems[0];
    const secondItem = appItems[1];
    const first = await applicationService.issueUploadedApplication({
      applicationId: app.id,
      adminId: 'admin-1',
      itemId: firstItem.id,
      invoiceNumber: 'HK-202610-001',
      issuingEntity: '102ISSHK',
      issueDate: new Date(Date.UTC(2026, 9, 9)),
      pdfFile: { filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a') },
    });
    expect(first.status).toBe('APPROVED_ISSUING');
    expect(first.items.find((item: { id: string }) => item.id === firstItem.id)).toMatchObject({
      invoiceNumber: 'HK-202610-001',
    });
    const second = await applicationService.issueUploadedApplication({
      applicationId: app.id,
      adminId: 'admin-1',
      itemId: secondItem.id,
      invoiceNumber: 'HK-202610-002',
      issuingEntity: '102ISSHK',
      issueDate: new Date(Date.UTC(2026, 9, 9)),
      pdfFile: { filename: 'b.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 b') },
    });
    expect(second.status).toBe('ISSUED');
    expect(second.items.every((item) => Boolean((item as { pdfUrl?: string | null }).pdfUrl))).toBe(true);
  });

  it('admin 手工上传票据 → 使用实际发票号、不写到期日并发布下载地址', async () => {
    const { applicationService, app, storageService } = await setupWithApp('APPROVED_ISSUING');
    const issued = await applicationService.issueUploadedApplication({
      applicationId: app.id,
      adminId: 'admin-1',
      invoiceNumber: 'CN-202606-001',
      issuingEntity: '国内主体',
      issueDate: new Date(Date.UTC(2026, 5, 23)),
      pdfFile: {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 test'),
      },
    });
    expect(issued.status).toBe('ISSUED');
    expect(issued.invoiceNumber).toBe('CN-202606-001');
    expect(issued.dueDate).toBeNull();
    expect((issued as { pdfUrl?: string }).pdfUrl).toMatch(
      /^invoices\/u1\/manual-app-1-[0-9a-f-]{36}-pdf\.pdf$/,
    );
    expect(storageService.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        applicationId: app.id,
        extension: 'pdf',
        contentType: 'application/pdf',
      }),
    );
    const listed = await applicationService.listApplications('u1', 't1', {
      description: 'RAYTONE_API',
      page: 1,
      pageSize: 100,
    });
    expect(listed.items[0]).toMatchObject({
      id: app.id,
      status: 'ISSUED',
      pdfUrl: expect.stringMatching(/^invoices\/u1\/manual-app-1-[0-9a-f-]{36}-pdf\.pdf$/),
    });
    const detail = await applicationService.getApplication('u1', 't1', app.id);
    expect(detail).toMatchObject({
      id: app.id,
      status: 'ISSUED',
      pdfUrl: expect.stringMatching(/^invoices\/u1\/manual-app-1-[0-9a-f-]{36}-pdf\.pdf$/),
    });
    await expect(storageService.resolveForDownload((issued as { pdfUrl: string }).pdfUrl))
      .resolves.toEqual({
        kind: 's3',
        url: expect.stringMatching(
          /^https:\/\/s3\.test\/invoices\/u1\/manual-app-1-[0-9a-f-]{36}-pdf\.pdf$/,
        ),
      });
  });

  it('admin 手工上传票据：PDF 伪文件 → 拒绝且不写入存储', async () => {
    const { applicationService, app, storageService } = await setupWithApp('APPROVED_ISSUING');
    await expect(
      applicationService.issueUploadedApplication({
        applicationId: app.id,
        adminId: 'admin-1',
        invoiceNumber: 'CN-202606-001',
        issuingEntity: '国内主体',
        issueDate: new Date(Date.UTC(2026, 5, 23)),
        pdfFile: {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          buffer: Buffer.from('not a real pdf'),
        },
      }),
    ).rejects.toBeInstanceOf(InvoiceInvalidUploadedFileError);
    expect(storageService.persist).not.toHaveBeenCalled();
  });

  it('admin 手工上传票据：DB 写入失败 → 清理已上传 PDF/OFD', async () => {
    const { applicationService, app, fakes, storageService } = await setupWithApp('APPROVED_ISSUING');
    const tx = fakes.prisma.$transaction as jest.Mock;
    tx.mockImplementationOnce(async () => {
      throw new Error('db write failed');
    });

    await expect(
      applicationService.issueUploadedApplication({
        applicationId: app.id,
        adminId: 'admin-1',
        invoiceNumber: 'CN-202606-002',
        issuingEntity: '国内主体',
        issueDate: new Date(Date.UTC(2026, 5, 23)),
        pdfFile: {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 test'),
        },
        ofdFile: {
          filename: 'invoice.ofd',
          contentType: 'application/octet-stream',
          buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
        },
      }),
    ).rejects.toThrow('db write failed');

    expect(storageService.deleteObject).toHaveBeenCalledTimes(2);
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      expect.stringMatching(/^invoices\/u1\/manual-app-1-[0-9a-f-]{36}-pdf\.pdf$/),
    );
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      expect.stringMatching(/^invoices\/u1\/manual-app-1-[0-9a-f-]{36}-ofd\.ofd$/),
    );
  });

  it('手工出票缺 PDF 文件 → 抛 missing data', async () => {
    const { applicationService, app } = await setupWithApp('APPROVED_ISSUING');
    await expect(
      applicationService.issueUploadedApplication({
        applicationId: app.id,
        adminId: 'admin-1',
        invoiceNumber: 'HK-202606-002',
        issuingEntity: '102ISSHK',
        issueDate: new Date(),
        pdfFile: {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          buffer: Buffer.alloc(0),
        },
      }),
    ).rejects.toThrow();
  });

  it('手工出票：发票号码已被占用 → 409 且不上传文件', async () => {
    const harness = await setupWithApp('ISSUED'); // 该申请已占用 MANUAL-202606-001
    const { applicationService, service, fakes, storageService } = harness;
    (storageService.persist as jest.Mock).mockClear();
    fakes.orders.set('o2', makeOrder({ id: 'o2', userId: 'u1', tenantId: 't1' }));
    fakes.allocationsByOrderUsd.set('o2', 10);
    const second = await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o2' }], idempotencyKey: 'idem-dup-number',
    });
    await applicationService.approveApplication(second.id, 'admin-1');

    await expect(
      applicationService.issueUploadedApplication({
        applicationId: second.id,
        adminId: 'admin-1',
        invoiceNumber: 'MANUAL-202606-001',
        issuingEntity: '国内主体',
        issueDate: new Date(Date.UTC(2026, 5, 23)),
        pdfFile: {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 test'),
        },
      }),
    ).rejects.toBeInstanceOf(InvoiceNumberAlreadyUsedError);
    expect(storageService.persist).not.toHaveBeenCalled();
  });

  it('手工出票：同一申请内不同订单也不能复用发票号', async () => {
    const harness = await buildService();
    const { fakes, applicationService, service, storageService } = harness;
    fakes.orders.set('o1', makeOrder({ id: 'o1', userId: 'u1', tenantId: 't1', amountCents: 1000 }));
    fakes.orders.set('o2', makeOrder({ id: 'o2', userId: 'u1', tenantId: 't1', amountCents: 2000 }));
    fakes.allocationsByOrderUsd.set('o1', 10);
    fakes.allocationsByOrderUsd.set('o2', 20);
    const app = await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }, { orderId: 'o2' }],
      idempotencyKey: 'idem-dup-sibling',
    });
    await applicationService.approveApplication(app.id, 'admin-1');
    const [firstItem, secondItem] = fakes.items.filter((item) => item.applicationId === app.id);
    await applicationService.issueUploadedApplication({
      applicationId: app.id,
      adminId: 'admin-1',
      itemId: firstItem.id,
      invoiceNumber: 'HK-202610-001',
      issuingEntity: '102ISSHK',
      issueDate: new Date(Date.UTC(2026, 9, 9)),
      pdfFile: { filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a') },
    });
    (storageService.persist as jest.Mock).mockClear();
    await expect(
      applicationService.issueUploadedApplication({
        applicationId: app.id,
        adminId: 'admin-1',
        itemId: secondItem.id,
        invoiceNumber: ' hk-202610-001 ',
        issuingEntity: '102ISSHK',
        issueDate: new Date(Date.UTC(2026, 9, 9)),
        pdfFile: { filename: 'b.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 b') },
      }),
    ).rejects.toBeInstanceOf(InvoiceNumberAlreadyUsedError);
    expect(storageService.persist).not.toHaveBeenCalled();
  });

  it('手工出票：并发窗口内撞号(P2002) → 409 且清理已上传对象', async () => {
    const { applicationService, app, fakes, storageService } = await setupWithApp('APPROVED_ISSUING');
    const tx = fakes.prisma.$transaction as jest.Mock;
    tx.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });

    await expect(
      applicationService.issueUploadedApplication({
        applicationId: app.id,
        adminId: 'admin-1',
        invoiceNumber: 'CN-202606-003',
        issuingEntity: '国内主体',
        issueDate: new Date(Date.UTC(2026, 5, 23)),
        pdfFile: {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 test'),
        },
      }),
    ).rejects.toBeInstanceOf(InvoiceNumberAlreadyUsedError);
    expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      expect.stringMatching(/^invoices\/u1\/manual-app-1-[0-9a-f-]{36}-pdf\.pdf$/),
    );
  });

  it('void 仅 ISSUED 可', async () => {
    const { applicationService, app } = await setupWithApp('ISSUED');
    const voided = await applicationService.voidApplication(app.id, 'admin-1', '客户主动作废');
    expect(voided.status).toBe('VOIDED');
  });
});

describe('InvoiceService — 并发与失败补救', () => {
  function seedOrder(fakes: ReturnType<typeof buildFakes>) {
    fakes.orders.set('o1', makeOrder({ id: 'o1', userId: 'u1', tenantId: 't1' }));
    fakes.allocationsByOrderUsd.set('o1', 10);
  }

  it('并发同 idempotencyKey：P2002 → 回放已存在申请，不重复创建', async () => {
    const { service, fakes } = await buildService();
    seedOrder(fakes);

    const existing = {
      id: 'app-existing', status: 'PENDING_REVIEW', userId: 'u1', tenantId: 't1',
      subtotalCents: 1000, items: [],
    };
    let idemReads = 0;
    (fakes.prisma.idempotencyKey as { findUnique: jest.Mock }).findUnique.mockImplementation(
      async () => (++idemReads === 1 ? null : { result: existing }),
    );
    (fakes.prisma.$transaction as jest.Mock).mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError('dup idem', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });

    const app = await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }], idempotencyKey: 'idem-dup-1',
    });
    expect(app).toEqual(existing);
    expect((fakes.prisma.invoiceApplication as { create: jest.Mock }).create).not.toHaveBeenCalled();
  });

  it('相同幂等键在不同用户下互不回放', async () => {
    const { service, fakes } = await buildService();
    seedOrder(fakes);
    fakes.orders.set('o2', makeOrder({ id: 'o2', userId: 'u2', tenantId: 't1' }));
    fakes.allocationsByOrderUsd.set('o2', 10);

    await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }], idempotencyKey: 'idem-shared',
    });
    await service.submitApplication({
      userId: 'u2', tenantId: 't1', profileId: 'p2',
      items: [{ orderId: 'o2' }], idempotencyKey: 'idem-shared',
    });

    expect(fakes.applications).toHaveLength(2);
  });

  it('并发写偏序：P2034 → 重试后成功创建', async () => {
    const { service, fakes } = await buildService();
    seedOrder(fakes);

    const tx = fakes.prisma.$transaction as jest.Mock;
    const base = tx.getMockImplementation() as (cb: unknown) => Promise<unknown>;
    let calls = 0;
    tx.mockImplementation(async (cb: unknown) => {
      if (++calls === 1) {
        throw new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: 'test',
        });
      }
      return base(cb);
    });

    const app = await service.submitApplication({
      userId: 'u1', tenantId: 't1', profileId: 'p1',
      items: [{ orderId: 'o1' }], idempotencyKey: 'idem-p2034',
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(app.status).toBe('PENDING_REVIEW');
    expect(app.subtotalCents).toBe(1000);
  });

});

describe('InvoiceService — 国际充值历史金额修复', () => {
  function seedRechargeRepairCase(
    fakes: ReturnType<typeof buildFakes>,
    status: 'PENDING_REVIEW' | 'FAILED' | 'ISSUED',
  ) {
    fakes.orders.set('recharge-1', makeOrder({
      id: 'recharge-1',
      userId: 'u1',
      tenantId: 't1',
      amountCents: 1000,
    }));
    fakes.applications.push({
      id: `app-${status.toLowerCase()}`,
      applicationNo: `IA-${status}`,
      invoiceNumber: status === 'ISSUED' ? '102ISSHK202606001' : null,
      status,
      userId: 'u1',
      tenantId: 't1',
      currency: 'usd',
      subtotalCents: 300,
      taxAmountCents: 0,
      totalCents: 300,
      profileId: 'p1',
      profileSnapshot: { title: 'Acme HK' },
      failedReason: status === 'FAILED' ? 'old amount bug' : null,
      items: [{
        id: `item-${status.toLowerCase()}`,
        orderId: 'recharge-1',
        principalCents: 300,
        description: 'RAYTONE_API',
        productName: 'API Credits',
        serviceStart: null,
        serviceEnd: null,
        poNumber: null,
      }],
      pdfUrl: status === 'ISSUED' ? 'invoices/u1/old.pdf' : null,
    });
    fakes.items.push({
      id: `item-${status.toLowerCase()}`,
      applicationId: `app-${status.toLowerCase()}`,
      orderId: 'recharge-1',
      principalCents: 300,
      description: 'RAYTONE_API',
      productName: 'API Credits',
      serviceStart: null,
      serviceEnd: null,
      poNumber: null,
      status,
    });
    return `app-${status.toLowerCase()}`;
  }

  it('dryRun 只审计历史充值发票金额差异，不写库不出票', async () => {
    const { service, fakes, storageService } = await buildService();
    seedRechargeRepairCase(fakes, 'PENDING_REVIEW');

    const result = await service.repairRechargeInvoices({
      adminId: 'admin-1',
      dryRun: true,
      applicationIds: ['app-pending_review'],
    });

    expect(result).toMatchObject({
      dryRun: true,
      candidates: 1,
      repaired: 0,
    });
    expect(result.items[0]).toMatchObject({
      applicationId: 'app-pending_review',
      action: 'update_in_place',
      previousSubtotalCents: 300,
      expectedSubtotalCents: 1000,
      deltaCents: 700,
    });
    expect(fakes.applications[0]).toMatchObject({ subtotalCents: 300, status: 'PENDING_REVIEW' });
    expect(storageService.persist).not.toHaveBeenCalled();
  });

  it('FAILED 历史充值发票原地修成充值金额并回到待审核', async () => {
    const { service, fakes, storageService } = await buildService();
    seedRechargeRepairCase(fakes, 'FAILED');

    const result = await service.repairRechargeInvoices({
      adminId: 'admin-1',
      dryRun: false,
      applicationIds: ['app-failed'],
    });

    expect(result).toMatchObject({
      dryRun: false,
      candidates: 1,
      repaired: 1,
    });
    const app = fakes.applications.find((row) => row.id === 'app-failed');
    expect(app).toMatchObject({
      status: 'PENDING_REVIEW',
      subtotalCents: 1000,
      totalCents: 1000,
      failedReason: null,
      pdfUrl: null,
    });
    expect(fakes.items.find((item) => item.id === 'item-failed')).toMatchObject({
      principalCents: 1000,
      status: 'PENDING_REVIEW',
    });
    expect(storageService.persist).not.toHaveBeenCalled();
  });

  it('ISSUED 历史充值发票红冲旧申请，并按充值金额创建待审核替代申请', async () => {
    const { service, fakes, storageService } = await buildService();
    seedRechargeRepairCase(fakes, 'ISSUED');

    const result = await service.repairRechargeInvoices({
      adminId: 'admin-1',
      dryRun: false,
      applicationIds: ['app-issued'],
    });

    expect(result).toMatchObject({
      dryRun: false,
      candidates: 1,
      repaired: 1,
    });
    expect(result.items[0].replacementApplicationId).toBe('app-2');
    const original = fakes.applications.find((row) => row.id === 'app-issued');
    const replacement = fakes.applications.find((row) => row.id === 'app-2');
    expect(original).toMatchObject({
      status: 'RED_OFFSET',
      subtotalCents: 300,
      voidReason: 'repair_international_recharge_invoice_paid_amount',
    });
    expect(replacement).toMatchObject({
      status: 'PENDING_REVIEW',
      subtotalCents: 1000,
      totalCents: 1000,
      pdfUrl: null,
    });
    expect(fakes.items.find((item) => item.applicationId === 'app-2')).toMatchObject({
      orderId: 'recharge-1',
      principalCents: 1000,
      status: 'PENDING_REVIEW',
    });
    expect(storageService.persist).not.toHaveBeenCalled();
  });
});
