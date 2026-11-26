import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  InvoiceApplication,
  InvoiceLineDescription,
  InvoiceProfile,
  Prisma,
} from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceEventService } from './invoice-event.service';
import { InvoiceNothingToInvoiceError } from './invoice.errors';
import { InvoiceProfileService } from './invoice-profile.service';
import {
  INVOICE_OCCUPYING_STATUSES,
  INVOICEABLE_ORDER_STATUSES,
  invoiceLineDescriptionForOrder,
  invoiceProductNameForOrder,
} from './invoice-source.util';
import {
  InvoicePeriodSourceRow,
  InvoiceSourceService,
} from './invoice-source.service';
import type {
  InvoiceablePurchase,
  SubmitApplicationInput,
} from './invoice-international.service';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const IDEMPOTENCY_SCOPE = 'invoice:submit';
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APPLICATION_NO_PREFIX = 'IA';

type Tx = PrismaService | Prisma.TransactionClient;

export type InvoiceablePeriodStatus = 'invoiceable' | 'not_invoiceable' | 'unclosed';

export interface InvoiceablePeriod {
  period: string;
  serviceStart: Date;
  serviceEnd: Date;
  consumedPrincipalCents: number;
  occupiedInvoiceCents: number;
  invoiceableCents: number;
  currency: string;
  recordCount: number;
  productName: string | null;
  status: InvoiceablePeriodStatus;
}

export interface ListInvoiceablePeriodsInput {
  userId: string;
  tenantId: string;
  year?: number;
  month?: number;
  description?: InvoiceLineDescription;
}

export interface SubmitPeriodApplicationInput {
  userId: string;
  tenantId: string;
  profileId: string;
  period: string;
  idempotencyKey: string;
  description?: InvoiceLineDescription;
  poNumber?: string | null;
}

type PeriodOrderRow = InvoicePeriodSourceRow;

interface PeriodOrderAllocation extends PeriodOrderRow {
  globalOccupiedInvoiceCents: number;
  occupiedInvoiceCents: number;
  invoiceableCents: number;
}

@Injectable()
export class InvoiceDomesticService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly profileService: InvoiceProfileService,
    private readonly eventService: InvoiceEventService,
    private readonly sourceService: InvoiceSourceService,
  ) {}

  async listInvoiceablePurchases(
    userId: string,
    tenantId: string,
  ): Promise<InvoiceablePurchase[]> {
    const orders = (await this.sourceService.listInvoiceableOrders({
      userId,
      tenantId,
      paidBefore: new Date(),
    }))
      .filter((order) => invoiceLineDescriptionForOrder(order) === 'TOKEN_PLAN')
      .filter((order) => order.currency.trim().toLowerCase() === 'cny');
    if (orders.length === 0) return [];

    const orderIds = orders.map((order) => order.id);
    const baseMap = await this.sourceService.computeBasesForOrders(orders);
    const occupiedRows = await this.prisma.invoiceApplicationItem.groupBy({
      by: ['orderId'],
      where: {
        orderId: { in: orderIds },
        application: { status: { in: INVOICE_OCCUPYING_STATUSES } },
      },
      _sum: { principalCents: true },
    });
    const occupiedMap = new Map(
      occupiedRows.map((row) => [row.orderId, row._sum.principalCents ?? 0]),
    );

    return orders.map((order) => {
      const base = baseMap.get(order.id) ?? { baseCents: 0, consumedPrincipalCents: 0 };
      const occupiedInvoiceCents = occupiedMap.get(order.id) ?? 0;
      const invoiceableCents = Math.max(0, base.baseCents - occupiedInvoiceCents);
      return {
        orderId: order.id,
        orderType: order.orderType,
        paidAt: order.paidAt,
        paidAmountCents: order.amountCents,
        bonusCents: order.bonusCents,
        consumedPrincipalCents: base.consumedPrincipalCents,
        occupiedInvoiceCents,
        invoiceableCents,
        currency: order.currency,
        productId: order.productId,
        productName: invoiceProductNameForOrder(order),
        description: 'TOKEN_PLAN',
        status: order.status,
      };
    });
  }

  async listInvoiceablePeriods(input: ListInvoiceablePeriodsInput): Promise<InvoiceablePeriod[]> {
    if (input.description === 'TOKEN_PLAN') {
      throw new BadRequestException('订阅类订单请在 TokenPlan 页面按订单申请开票');
    }
    const range = periodFilterRange(input.year, input.month);
    return this.prisma.$transaction(async (tx) => {
      const subject = await this.resolveInvoiceBillingSubject(
        tx,
        input.userId,
        input.tenantId,
      );
      const rows = await this.loadPeriodOrderRows(
        input.userId,
        input.tenantId,
        subject.billingAccountId,
        range.start,
        range.end,
        tx,
        'RAYTONE_API',
      );
      if (rows.length === 0) return [];

      const allocations = await this.applyOccupiedInvoiceCents(rows, tx);
      const grouped = new Map<string, InvoiceablePeriod>();
      const now = Date.now();

      for (const row of allocations) {
        const bounds = parsePeriod(row.period);
        const current = grouped.get(row.period) ?? {
          period: row.period,
          serviceStart: bounds.start,
          serviceEnd: bounds.end,
          consumedPrincipalCents: 0,
          occupiedInvoiceCents: 0,
          invoiceableCents: 0,
          currency: row.currency,
          recordCount: 0,
          productName: row.productName,
          status: 'not_invoiceable' as InvoiceablePeriodStatus,
        };
        current.consumedPrincipalCents += row.periodConsumedPrincipalCents;
        current.occupiedInvoiceCents += row.occupiedInvoiceCents;
        current.invoiceableCents += row.invoiceableCents;
        current.recordCount += row.recordCount;
        if (current.currency !== row.currency) {
          current.currency = 'mixed';
        }
        if (current.productName !== row.productName) {
          current.productName = null;
        }
        current.status = bounds.end.getTime() > now
          ? 'unclosed'
          : current.invoiceableCents > 0
            ? 'invoiceable'
            : 'not_invoiceable';
        grouped.set(row.period, current);
      }

      return [...grouped.values()].sort((a, b) => b.period.localeCompare(a.period));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async submitPeriodApplication(input: SubmitPeriodApplicationInput): Promise<InvoiceApplication> {
    if (input.description === 'TOKEN_PLAN') {
      throw new BadRequestException('订阅类订单请在 TokenPlan 页面按订单申请开票');
    }
    const bounds = parsePeriod(input.period);
    if (bounds.end.getTime() > Date.now()) {
      throw new BadRequestException('当前账期尚未出账，不能申请开票');
    }
    const preflight = await this.resolvePeriodSubmissionState(input);
    if (preflight.replay) return preflight.replay;

    return this.createPeriodApplication(
      input,
      bounds.start,
      bounds.end,
      preflight.billingAccountId,
    );
  }

  async submitApplication(input: SubmitApplicationInput): Promise<InvoiceApplication> {
    const scopedIdempotencyKey = scopedInvoiceIdempotencyKey(input);
    const cached = await this.prisma.idempotencyKey.findUnique({
      where: { key_scope: { key: scopedIdempotencyKey, scope: IDEMPOTENCY_SCOPE } },
    });
    if (cached?.result) {
      return cached.result as unknown as InvoiceApplication;
    }

    const orderIds = input.items.map((item) => item.orderId);
    if (new Set(orderIds).size !== orderIds.length) {
      throw new InvoiceNothingToInvoiceError();
    }

    const profile = await this.profileService.requireOwnedProfile(
      input.userId,
      input.tenantId,
      input.profileId,
    );

    const MAX_ATTEMPTS = 3;
    let application: InvoiceApplication | null = null;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        application = await this.prisma.$transaction(
          (tx) => this.createTokenPlanOrderApplicationTx(tx, input, profile, orderIds),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (err) {
        lastErr = err;
        const known = err instanceof Prisma.PrismaClientKnownRequestError ? err : null;
        if (known?.code === 'P2002') {
          const replay = await this.prisma.idempotencyKey.findUnique({
            where: { key_scope: { key: scopedIdempotencyKey, scope: IDEMPOTENCY_SCOPE } },
          });
          if (replay?.result) {
            application = replay.result as unknown as InvoiceApplication;
            break;
          }
          if (attempt < MAX_ATTEMPTS) continue;
        }
        if (known?.code === 'P2034' && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
    if (!application) throw lastErr ?? new InvoiceNothingToInvoiceError();
    return application;
  }

  private async createTokenPlanOrderApplicationTx(
    tx: Prisma.TransactionClient,
    input: SubmitApplicationInput,
    profile: InvoiceProfile,
    orderIds: string[],
  ): Promise<InvoiceApplication> {
    const orders = await this.sourceService.findOrdersByIds({
      userId: input.userId,
      tenantId: input.tenantId,
      orderIds,
      client: tx,
    });
    if (orders.length !== orderIds.length) {
      throw new InvoiceNothingToInvoiceError();
    }

    const currencies = new Set(orders.map((order) => order.currency));
    if (currencies.size > 1) {
      throw new BadRequestException('同一申请存在多币种订单，请按币种拆分开票');
    }
    const currency = [...currencies][0]?.trim().toLowerCase() ?? 'cny';
    if (currency !== 'cny') {
      throw new BadRequestException('国内版仅支持人民币订单开具增值税发票');
    }

    let subtotalCents = 0;
    const itemsToInsert: Prisma.InvoiceApplicationItemCreateManyApplicationInput[] = [];
    for (const order of orders) {
      if (invoiceLineDescriptionForOrder(order) !== 'TOKEN_PLAN') {
        throw new BadRequestException('国内版普通用量请按月账期申请开票');
      }
      if (
        order.refundedAt
        || !INVOICEABLE_ORDER_STATUSES.includes(order.status)
        || order.amountCents <= 0
        || !order.paidAt
        || order.paidAt.getTime() > Date.now()
      ) {
        throw new InvoiceNothingToInvoiceError(order.id);
      }

      const base = await this.sourceService.computeBaseForOrder(order, tx);
      const occupied = await tx.invoiceApplicationItem.aggregate({
        where: {
          orderId: order.id,
          application: { status: { in: INVOICE_OCCUPYING_STATUSES } },
        },
        _sum: { principalCents: true },
      });
      const invoiceableCents = Math.max(0, base.baseCents - (occupied._sum.principalCents ?? 0));
      if (invoiceableCents <= 0) throw new InvoiceNothingToInvoiceError(order.id);

      const itemInput = input.items.find((item) => item.orderId === order.id);
      const principalCents = itemInput?.principalCents ?? invoiceableCents;
      if (!Number.isInteger(principalCents) || principalCents <= 0 || principalCents > invoiceableCents) {
        throw new InvoiceNothingToInvoiceError(order.id);
      }

      subtotalCents += principalCents;
      itemsToInsert.push({
        orderId: order.id,
        principalCents,
        description: 'TOKEN_PLAN',
        productName: invoiceProductNameForOrder(order),
        serviceStart: itemInput?.serviceStart ?? null,
        serviceEnd: itemInput?.serviceEnd ?? null,
        poNumber: itemInput?.poNumber ?? null,
      });
    }

    if (subtotalCents <= 0) throw new InvoiceNothingToInvoiceError();
    const application = await tx.invoiceApplication.create({
      data: {
        applicationNo: generateApplicationNo(),
        userId: input.userId,
        tenantId: input.tenantId,
        profileId: profile.id,
        profileSnapshot: snapshotProfile(profile),
        currency,
        subtotalCents,
        taxAmountCents: 0,
        totalCents: subtotalCents,
        status: 'PENDING_REVIEW',
        idempotencyKey: input.idempotencyKey,
        items: { createMany: { data: itemsToInsert } },
      },
      include: { items: true },
    });

    await this.eventService.record(
      {
        applicationId: application.id,
        fromStatus: null,
        toStatus: 'PENDING_REVIEW',
        actorType: 'USER',
        actorId: input.userId,
        metadata: { deployment: 'domestic', source: 'TOKEN_PLAN' },
      },
      tx,
    );

    await tx.idempotencyKey.create({
      data: {
        key: scopedInvoiceIdempotencyKey(input),
        scope: IDEMPOTENCY_SCOPE,
        userId: input.userId,
        status: 'COMMITTED',
        result: application as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });

    return application;
  }

  private async createPeriodApplication(
    input: SubmitPeriodApplicationInput,
    periodStart: Date,
    periodEnd: Date,
    authorizedBillingAccountId: string,
  ): Promise<InvoiceApplication> {
    const profile = await this.profileService.requireOwnedProfile(
      input.userId,
      input.tenantId,
      input.profileId,
    );

    const MAX_ATTEMPTS = 3;
    let application: InvoiceApplication | null = null;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        application = await this.prisma.$transaction(
          (tx) => this.createPeriodApplicationTx(
            tx,
            input,
            profile,
            periodStart,
            periodEnd,
            authorizedBillingAccountId,
          ),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (err) {
        lastErr = err;
        const known = err instanceof Prisma.PrismaClientKnownRequestError ? err : null;
        if (known?.code === 'P2002') {
          const replayState = await this.resolvePeriodSubmissionState(input);
          if (replayState.billingAccountId !== authorizedBillingAccountId) {
            throw new ConflictException('账务主体在开票过程中发生变化，请重试');
          }
          application = replayState.replay;
          if (application) {
            break;
          }
          if (attempt < MAX_ATTEMPTS) continue;
        }
        if (known?.code === 'P2034' && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
    if (!application) throw lastErr ?? new InvoiceNothingToInvoiceError();
    return application;
  }

  private async createPeriodApplicationTx(
    tx: Prisma.TransactionClient,
    input: SubmitPeriodApplicationInput,
    profile: InvoiceProfile,
    periodStart: Date,
    periodEnd: Date,
    authorizedBillingAccountId: string,
  ): Promise<InvoiceApplication> {
    const subject = await this.resolveInvoiceBillingSubject(
      tx,
      input.userId,
      input.tenantId,
    );
    if (subject.billingAccountId !== authorizedBillingAccountId) {
      throw new ConflictException('账务主体在开票过程中发生变化，请重试');
    }
    const rows = await this.loadPeriodOrderRows(
      input.userId,
      input.tenantId,
      subject.billingAccountId,
      periodStart,
      periodEnd,
      tx,
      'RAYTONE_API',
    );
    const periodRows = rows.filter((row) => row.period === input.period);
    const allocations = (await this.applyOccupiedInvoiceCents(periodRows, tx))
      .filter((row) => row.invoiceableCents > 0);
    if (allocations.length === 0) {
      throw new InvoiceNothingToInvoiceError();
    }

    const currencies = new Set(allocations.map((row) => row.currency));
    if (currencies.size > 1) {
      throw new BadRequestException('同一账期存在多币种消费，请按币种拆分开票');
    }

    const subtotalCents = allocations.reduce((sum, row) => sum + row.invoiceableCents, 0);
    if (subtotalCents <= 0) throw new InvoiceNothingToInvoiceError();

    const serviceEnd = new Date(periodEnd.getTime() - 1);
    const application = await tx.invoiceApplication.create({
      data: {
        applicationNo: generateApplicationNo(),
        userId: input.userId,
        tenantId: input.tenantId,
        profileId: profile.id,
        profileSnapshot: snapshotProfile(profile),
        currency: allocations[0]?.currency ?? 'cny',
        subtotalCents,
        taxAmountCents: 0,
        totalCents: subtotalCents,
        status: 'PENDING_REVIEW',
        idempotencyKey: input.idempotencyKey,
        items: {
          createMany: {
            data: allocations.map((row) => ({
              orderId: row.orderId,
              principalCents: row.invoiceableCents,
              description: 'RAYTONE_API',
              productName: row.productName ?? '计费订单',
              serviceStart: periodStart,
              serviceEnd,
              poNumber: input.poNumber ?? null,
            })),
          },
        },
      },
      include: { items: true },
    });

    await this.eventService.record(
      {
        applicationId: application.id,
        fromStatus: null,
        toStatus: 'PENDING_REVIEW',
        actorType: 'USER',
        actorId: input.userId,
        metadata: {
          period: input.period,
          deployment: 'domestic',
          billingAccountId: subject.billingAccountId,
        },
      },
      tx,
    );

    await tx.idempotencyKey.create({
      data: {
        key: scopedInvoiceIdempotencyKey(input),
        scope: IDEMPOTENCY_SCOPE,
        userId: input.userId,
        status: 'COMMITTED',
        result: application as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });

    return application;
  }

  private resolveInvoiceBillingSubject(
    client: Tx,
    userId: string,
    tenantId: string,
  ) {
    return this.billingService.resolveSubjectForUserWithDb(
      client,
      userId,
      tenantId,
      {
        requireBillingRole: true,
        requireExplicitTenant: true,
        requireProvisionedBillingAccount: true,
      },
    );
  }

  private resolvePeriodSubmissionState(
    input: SubmitPeriodApplicationInput,
  ): Promise<{ billingAccountId: string; replay: InvoiceApplication | null }> {
    const scopedIdempotencyKey = scopedInvoiceIdempotencyKey(input);
    return this.prisma.$transaction(async (tx) => {
      const subject = await this.resolveInvoiceBillingSubject(
        tx,
        input.userId,
        input.tenantId,
      );
      const cached = await tx.idempotencyKey.findUnique({
        where: { key_scope: { key: scopedIdempotencyKey, scope: IDEMPOTENCY_SCOPE } },
      });
      const replay = cached?.result
        ? await this.requirePeriodReplayForBillingAccount(
          cached.result,
          input,
          subject.billingAccountId,
          tx,
        )
        : null;
      return { billingAccountId: subject.billingAccountId, replay };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private async requirePeriodReplayForBillingAccount(
    result: Prisma.JsonValue,
    input: SubmitPeriodApplicationInput,
    authorizedBillingAccountId: string,
    client: Tx,
  ): Promise<InvoiceApplication> {
    const applicationId = typeof result === 'object'
      && result !== null
      && !Array.isArray(result)
      && typeof result.id === 'string'
      ? result.id
      : null;
    const application = applicationId
      ? await client.invoiceApplication.findUnique({
        where: { id: applicationId },
        select: {
          userId: true,
          tenantId: true,
          items: {
            select: {
              description: true,
              serviceStart: true,
              order: { select: { billingAccountId: true } },
            },
          },
        },
      })
      : null;
    const belongsToAuthorizedAccount = application
      && application.userId === input.userId
      && application.tenantId === input.tenantId
      && application.items.length > 0
      && application.items.every(
        (item) => item.description === 'RAYTONE_API'
          && item.serviceStart !== null
          && toShanghaiPeriod(item.serviceStart) === input.period
          && item.order.billingAccountId === authorizedBillingAccountId,
      );
    if (!belongsToAuthorizedAccount) {
      throw new ConflictException('账务主体已发生变化，不能回放原开票申请');
    }
    return result as unknown as InvoiceApplication;
  }

  private async loadPeriodOrderRows(
    userId: string,
    tenantId: string,
    billingAccountId: string,
    start: Date,
    end: Date,
    client: Tx = this.prisma,
    description?: InvoiceLineDescription,
  ): Promise<PeriodOrderRow[]> {
    const rows = await this.sourceService.listDomesticPeriodRows({
      userId,
      tenantId,
      billingAccountId,
      start,
      end,
      client,
    });
    if (!description) return rows;
    return rows.filter((row) => row.description === description);
  }

  private async applyOccupiedInvoiceCents(
    rows: PeriodOrderRow[],
    client: Tx = this.prisma,
  ): Promise<PeriodOrderAllocation[]> {
    if (rows.length === 0) return [];
    const orderIds = [...new Set(rows.map((row) => row.orderId))];
    const globalOccupiedRows = await client.invoiceApplicationItem.groupBy({
      by: ['orderId'],
      where: {
        orderId: { in: orderIds },
        application: { status: { in: INVOICE_OCCUPYING_STATUSES } },
      },
      _sum: { principalCents: true },
    });
    const globalOccupiedMap = new Map(
      globalOccupiedRows.map((row) => [row.orderId, row._sum.principalCents ?? 0]),
    );

    const periodOccupiedRows = await client.invoiceApplicationItem.findMany({
      where: {
        orderId: { in: orderIds },
        application: { status: { in: INVOICE_OCCUPYING_STATUSES } },
        serviceStart: { not: null },
      },
      select: {
        orderId: true,
        principalCents: true,
        serviceStart: true,
      },
    });
    const periodOccupiedMap = new Map<string, number>();
    for (const row of periodOccupiedRows) {
      if (!row.serviceStart) continue;
      const period = toShanghaiPeriod(row.serviceStart);
      const key = `${period}\u0000${row.orderId}`;
      periodOccupiedMap.set(key, (periodOccupiedMap.get(key) ?? 0) + row.principalCents);
    }

    return rows.map((row) => {
      const globalOccupiedInvoiceCents = globalOccupiedMap.get(row.orderId) ?? 0;
      const occupiedInvoiceCents = periodOccupiedMap.get(`${row.period}\u0000${row.orderId}`) ?? 0;
      const totalOrderInvoiceableCents = Math.max(
        0,
        row.totalBaseCents - globalOccupiedInvoiceCents,
      );
      const periodInvoiceableCents = Math.max(
        0,
        row.periodConsumedPrincipalCents - occupiedInvoiceCents,
      );
      const invoiceableCents = Math.max(
        0,
        Math.min(periodInvoiceableCents, totalOrderInvoiceableCents),
      );
      return {
        ...row,
        globalOccupiedInvoiceCents,
        occupiedInvoiceCents,
        invoiceableCents,
      };
    });
  }
}

function periodFilterRange(year?: number, month?: number): { start: Date; end: Date } {
  const now = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  const y = year ?? now.getUTCFullYear();
  const startMonth = month ?? 1;
  const endMonth = month ?? 12;
  return {
    start: shanghaiMonthStart(y, startMonth),
    end: shanghaiMonthStart(y, endMonth + 1),
  };
}

function parsePeriod(period: string): { year: number; month: number; start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) {
    throw new BadRequestException('period 必须是 YYYY-MM 格式');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    year,
    month,
    start: shanghaiMonthStart(year, month),
    end: shanghaiMonthStart(year, month + 1),
  };
}

function shanghaiMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1) - SHANGHAI_OFFSET_MS);
}

function toShanghaiPeriod(value: Date): string {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function snapshotProfile(profile: {
  id: string;
  kind: string;
  invoiceType: string;
  title: string;
  taxNo: string | null;
  bankName: string | null;
  bankAccount: string | null;
  registeredAddress: string | null;
  registeredPhone: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  recipientAddress: string | null;
}): Prisma.InputJsonValue {
  return {
    id: profile.id,
    kind: profile.kind,
    invoiceType: profile.invoiceType,
    title: profile.title,
    taxNo: profile.taxNo,
    bankName: profile.bankName,
    bankAccount: profile.bankAccount,
    registeredAddress: profile.registeredAddress,
    registeredPhone: profile.registeredPhone,
    recipientName: profile.recipientName,
    recipientEmail: profile.recipientEmail,
    recipientPhone: profile.recipientPhone,
    recipientAddress: profile.recipientAddress,
  };
}

function generateApplicationNo(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `${APPLICATION_NO_PREFIX}-${y}${m}${d}-${random}`;
}

function scopedInvoiceIdempotencyKey(input: {
  tenantId: string;
  userId: string;
  idempotencyKey: string;
}): string {
  return `${input.tenantId}:${input.userId}:${input.idempotencyKey}`;
}
