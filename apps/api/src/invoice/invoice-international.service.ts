import { Injectable, Logger } from '@nestjs/common';
import {
  InvoiceApplication,
  InvoiceApplicationItem,
  InvoiceApplicationStatus,
  InvoiceLineDescription,
  InvoiceProfile,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceEventService } from './invoice-event.service';
import { InvoiceProfileService } from './invoice-profile.service';
import {
  InvoiceApplicationNotFoundError,
  InvoiceCurrencyMismatchError,
  InvoiceNothingToInvoiceError,
  InvoiceOrderNotFoundError,
} from './invoice.errors';
import {
  INVOICE_OCCUPYING_STATUSES,
  INVOICEABLE_MIN_AGE_MS,
  INVOICEABLE_ORDER_STATUSES,
  invoiceLineDescriptionForOrder,
  invoiceProductNameForOrder,
  InvoiceSourceOrderLike,
} from './invoice-source.util';
import { InvoiceSourceService } from './invoice-source.service';

type Tx = PrismaService | Prisma.TransactionClient;

const IDEMPOTENCY_SCOPE = 'invoice:submit';
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APPLICATION_NO_PREFIX = 'IA';

export interface InvoiceablePurchase {
  orderId: string;
  orderType: string;
  paidAt: Date | null;
  paidAmountCents: number;
  bonusCents: number;
  consumedPrincipalCents: number;
  occupiedInvoiceCents: number;
  invoiceableCents: number;
  currency: string;
  productId: string | null;
  productName: string | null;
  description: InvoiceLineDescription;
  status: string;
}

export interface SubmitItemInput {
  orderId: string;
  principalCents?: number;
  description?: InvoiceLineDescription;
  poNumber?: string | null;
  serviceStart?: Date | null;
  serviceEnd?: Date | null;
}

export interface SubmitApplicationInput {
  userId: string;
  tenantId: string;
  profileId: string;
  items: SubmitItemInput[];
  idempotencyKey: string;
}

const REPAIR_RECHARGE_AMOUNT_REASON = 'repair_international_recharge_invoice_paid_amount';
const REPAIRABLE_RECHARGE_STATUSES: InvoiceApplicationStatus[] = [
  'PENDING_REVIEW',
  'FAILED',
  'ISSUED',
];

type RechargeRepairAction = 'none' | 'update_in_place' | 'red_offset_and_reissue' | 'skipped';

type RechargeRepairApplication = InvoiceApplication & {
  items: Array<InvoiceApplicationItem & {
    order: Pick<
      InvoiceSourceOrderLike,
      'id' | 'orderType' | 'amountCents' | 'currency' | 'status' | 'refundedAt' | 'paidAt'
    >;
  }>;
};

interface RechargeRepairItemPlan {
  itemId: string;
  orderId: string;
  previousPrincipalCents: number;
  expectedPrincipalCents: number;
}

interface RechargeRepairPlan {
  applicationId: string;
  applicationNo: string;
  invoiceNumber: string | null;
  status: InvoiceApplicationStatus;
  action: RechargeRepairAction;
  reason: string | null;
  previousSubtotalCents: number;
  expectedSubtotalCents: number;
  previousTotalCents: number;
  expectedTotalCents: number;
  deltaCents: number;
  orderIds: string[];
  replacementApplicationId?: string;
  items: RechargeRepairItemPlan[];
}

export interface RepairRechargeInvoicesInput {
  adminId: string;
  dryRun: boolean;
  applicationIds?: string[];
  limit?: number;
}

export interface RepairRechargeInvoicesResult {
  dryRun: boolean;
  scanned: number;
  candidates: number;
  repaired: number;
  skipped: number;
  items: RechargeRepairPlan[];
}

@Injectable()
export class InvoiceInternationalService {
  private readonly logger = new Logger(InvoiceInternationalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly profileService: InvoiceProfileService,
    private readonly eventService: InvoiceEventService,
    private readonly sourceService: InvoiceSourceService,
  ) {}

  // ============================
  // 可开票计算
  // ============================

  /**
   * 单订单可开票金额：
   * - 充值订单：订单实付 cents - 已占用 cents。BONUS 不参与。
   * - 其它付费账单订单：订单实付 cents - 已占用 cents。
   * refunded / FAILED / 冷静期内订单一律为 0。
   */
  async computeInvoiceableForOrder(
    order: InvoiceSourceOrderLike,
    tx?: Tx,
  ): Promise<number> {
    if (order.refundedAt) return 0;
    if (!INVOICEABLE_ORDER_STATUSES.includes(order.status)) return 0;
    if (order.amountCents <= 0) return 0;
    // 24h 冷静期：未付款或付款不足 24h 一律不可开票。
    if (!order.paidAt || order.paidAt.getTime() > Date.now() - INVOICEABLE_MIN_AGE_MS) {
      return 0;
    }

    const client = tx ?? this.prisma;
    const base = await this.sourceService.computeBaseForOrder(order, client);

    const occupied = await client.invoiceApplicationItem.aggregate({
      where: {
        orderId: order.id,
        application: { status: { in: INVOICE_OCCUPYING_STATUSES } },
      },
      _sum: { principalCents: true },
    });
    const occupiedCents = occupied._sum.principalCents ?? 0;

    return Math.max(0, base.baseCents - occupiedCents);
  }

  /**
   * 列出用户当前可开票的付费订单（含已开/未开/部分占用），按 paidAt desc 排序。
   */
  async listInvoiceablePurchases(
    userId: string,
    tenantId: string,
  ): Promise<InvoiceablePurchase[]> {
    const orders = await this.sourceService.listInvoiceableOrders({ userId, tenantId });
    if (orders.length === 0) return [];

    const orderIds = orders.map((o) => o.id);
    const baseMap = await this.sourceService.computeBasesForOrders(orders);

    const occupied = await this.prisma.invoiceApplicationItem.groupBy({
      by: ['orderId'],
      where: {
        orderId: { in: orderIds },
        application: { status: { in: INVOICE_OCCUPYING_STATUSES } },
      },
      _sum: { principalCents: true },
    });
    const occupiedMap = new Map(
      occupied.map((o) => [o.orderId, o._sum.principalCents ?? 0]),
    );

    return orders.map((o) => {
      const base = baseMap.get(o.id) ?? { baseCents: 0, consumedPrincipalCents: 0 };
      const occupiedInvoiceCents = occupiedMap.get(o.id) ?? 0;
      const invoiceableCents = Math.max(0, base.baseCents - occupiedInvoiceCents);
      return {
        orderId: o.id,
        orderType: o.orderType,
        paidAt: o.paidAt,
        paidAmountCents: o.amountCents,
        bonusCents: o.bonusCents,
        consumedPrincipalCents: base.consumedPrincipalCents,
        occupiedInvoiceCents,
        invoiceableCents,
        currency: o.currency,
        productId: o.productId,
        productName: invoiceProductNameForOrder(o),
        description: invoiceLineDescriptionForOrder(o),
        status: o.status,
      };
    });
  }

  // ============================
  // 提交申请
  // ============================

  async submitApplication(input: SubmitApplicationInput): Promise<InvoiceApplication> {
    const scopedIdempotencyKey = scopedInvoiceIdempotencyKey(input);
    const cached = await this.prisma.idempotencyKey.findUnique({
      where: { key_scope: { key: scopedIdempotencyKey, scope: IDEMPOTENCY_SCOPE } },
    });
    if (cached?.result) {
      return cached.result as unknown as InvoiceApplication;
    }

    const profile = await this.profileService.requireOwnedProfile(
      input.userId,
      input.tenantId,
      input.profileId,
    );

    const orderIds = input.items.map((i) => i.orderId);
    if (new Set(orderIds).size !== orderIds.length) {
      throw new InvoiceNothingToInvoiceError();
    }

    const runSubmitTx = (tx: Prisma.TransactionClient) =>
      this.createApplicationTx(tx, input, profile, orderIds);

    // Serializable 下并发可能抛 P2034（写偏序冲突）或 P2002（幂等键/单号唯一冲突），整体重试。
    const MAX_ATTEMPTS = 3;
    let application: InvoiceApplication | null = null;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        application = await this.prisma.$transaction(runSubmitTx, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
        break;
      } catch (err) {
        lastErr = err;
        const known = err instanceof Prisma.PrismaClientKnownRequestError ? err : null;
        if (known?.code === 'P2002') {
          // 幂等键并发冲突：另一路同 key 提交已落库 → 回放其结果，不再重复创建。
          const replay = await this.prisma.idempotencyKey.findUnique({
            where: { key_scope: { key: scopedIdempotencyKey, scope: IDEMPOTENCY_SCOPE } },
          });
          if (replay?.result) {
            application = replay.result as unknown as InvoiceApplication;
            break;
          }
          // 非幂等键冲突（applicationNo 撞号）→ 重试换号。
          if (attempt < MAX_ATTEMPTS) continue;
        }
        if (known?.code === 'P2034' && attempt < MAX_ATTEMPTS) {
          // 序列化失败：重试。若重试时订单已被并发那一路占用，
          // computeInvoiceableForOrder 返回 0 → 自然降级为 NothingToInvoice 友好报错。
          this.logger.warn(
            `submitApplication serialization conflict (P2034), retry ${attempt}/${MAX_ATTEMPTS}`,
          );
          continue;
        }
        throw err;
      }
    }
    if (!application) throw lastErr ?? new InvoiceNothingToInvoiceError();
    return application;
  }

  /**
   * submitApplication 的事务体：校验订单归属 + 计算可开额度 + 落 application/items/event/幂等键。
   * 抽成独立方法，便于提交事务在并发冲突（P2002/P2034）时整体重试。
   */
  private async createApplicationTx(
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
      throw new InvoiceOrderNotFoundError();
    }

    const currencies = new Set(orders.map((o) => o.currency));
    if (currencies.size > 1) throw new InvoiceCurrencyMismatchError();
    const currency = [...currencies][0];

    let subtotalCents = 0;
    const itemsToInsert: Prisma.InvoiceApplicationItemCreateManyApplicationInput[] = [];

    for (const order of orders) {
      const invoiceable = await this.computeInvoiceableForOrder(order, tx);
      if (invoiceable <= 0) throw new InvoiceNothingToInvoiceError(order.id);

      const itemInput = input.items.find((i) => i.orderId === order.id);
      if (!itemInput) throw new InvoiceOrderNotFoundError();

      const principalCents = itemInput.principalCents ?? invoiceable;
      if (!Number.isInteger(principalCents) || principalCents <= 0 || principalCents > invoiceable) {
        throw new InvoiceNothingToInvoiceError(order.id);
      }

      subtotalCents += principalCents;
      itemsToInsert.push({
        orderId: order.id,
        principalCents,
        description: itemInput.description ?? invoiceLineDescriptionForOrder(order),
        productName: invoiceProductNameForOrder(order),
        serviceStart: itemInput.serviceStart ?? null,
        serviceEnd: itemInput.serviceEnd ?? null,
        poNumber: itemInput.poNumber ?? null,
      });
    }

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

  /**
   * 历史补救：早期国际版充值发票曾按已消费本金开票；国际版应按充值实付金额开票。
   *
   * - dryRun=true：只审计并返回需要修复的申请。
   * - PENDING_REVIEW / FAILED：原地把明细金额修成订单实付金额并回到待审核。
   * - ISSUED：不改旧票据内容，先把旧申请标记 RED_OFFSET，再创建正确金额的新待审核申请。
   */
  async repairRechargeInvoices(
    input: RepairRechargeInvoicesInput,
  ): Promise<RepairRechargeInvoicesResult> {
    const applications = await this.loadRechargeRepairApplications(input);
    const plans = applications.map((application) => this.buildRechargeRepairPlan(application));
    const actionable = plans.filter((plan) =>
      plan.action === 'update_in_place' || plan.action === 'red_offset_and_reissue',
    );

    if (input.dryRun) {
      return summarizeRechargeRepair(input.dryRun, applications.length, plans);
    }

    const executed: RechargeRepairPlan[] = [];
    for (const plan of actionable) {
      const result = await this.applyRechargeRepairPlan(plan, input.adminId);
      executed.push(result);
    }

    const executedById = new Map(executed.map((plan) => [plan.applicationId, plan]));
    const finalPlans = plans.map((plan) => executedById.get(plan.applicationId) ?? plan);
    return summarizeRechargeRepair(input.dryRun, applications.length, finalPlans);
  }

  private async loadRechargeRepairApplications(
    input: RepairRechargeInvoicesInput,
  ): Promise<RechargeRepairApplication[]> {
    const ids = input.applicationIds?.map((id) => id.trim()).filter(Boolean);
    const where: Prisma.InvoiceApplicationWhereInput = {
      ...(ids?.length
        ? { id: { in: ids } }
        : { status: { in: REPAIRABLE_RECHARGE_STATUSES } }),
      items: { some: { order: { orderType: 'RECHARGE' } } },
    };
    const rows = await this.prisma.invoiceApplication.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: ids?.length ? undefined : input.limit ?? 100,
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            order: {
              select: {
                id: true,
                orderType: true,
                amountCents: true,
                currency: true,
                status: true,
                refundedAt: true,
                paidAt: true,
              },
            },
          },
        },
      },
    });
    return rows as RechargeRepairApplication[];
  }

  private buildRechargeRepairPlan(application: RechargeRepairApplication): RechargeRepairPlan {
    const rechargeItems = application.items.filter((item) => item.order.orderType === 'RECHARGE');
    const orderIds = rechargeItems.map((item) => item.orderId);
    const base = {
      applicationId: application.id,
      applicationNo: application.applicationNo,
      invoiceNumber: application.invoiceNumber,
      status: application.status,
      previousSubtotalCents: application.subtotalCents,
      expectedSubtotalCents: application.subtotalCents,
      previousTotalCents: application.totalCents,
      expectedTotalCents: application.totalCents,
      deltaCents: 0,
      orderIds,
      items: [] as RechargeRepairItemPlan[],
    };

    if (rechargeItems.length === 0) {
      return { ...base, action: 'skipped', reason: 'no_recharge_items' };
    }
    if (rechargeItems.length !== application.items.length) {
      return { ...base, action: 'skipped', reason: 'mixed_recharge_and_non_recharge_items' };
    }
    const invalidOrder = rechargeItems.find((item) =>
      item.order.refundedAt
      || !INVOICEABLE_ORDER_STATUSES.includes(item.order.status)
      || item.order.amountCents <= 0
      || !item.order.paidAt
      || item.order.paidAt.getTime() > Date.now() - INVOICEABLE_MIN_AGE_MS
    );
    if (invalidOrder) {
      return {
        ...base,
        action: 'skipped',
        reason: `order_not_invoiceable:${invalidOrder.orderId}`,
      };
    }
    if (!REPAIRABLE_RECHARGE_STATUSES.includes(application.status)) {
      return { ...base, action: 'skipped', reason: `unsupported_status:${application.status}` };
    }

    const items = rechargeItems.map((item) => ({
      itemId: item.id,
      orderId: item.orderId,
      previousPrincipalCents: item.principalCents,
      expectedPrincipalCents: item.order.amountCents,
    }));
    const expectedSubtotalCents = items.reduce(
      (sum, item) => sum + item.expectedPrincipalCents,
      0,
    );
    const expectedTotalCents = expectedSubtotalCents + application.taxAmountCents;
    const isAlreadyCorrect =
      application.subtotalCents === expectedSubtotalCents
      && application.totalCents === expectedTotalCents
      && items.every((item) => item.previousPrincipalCents === item.expectedPrincipalCents);

    if (isAlreadyCorrect) {
      return {
        ...base,
        expectedSubtotalCents,
        expectedTotalCents,
        items,
        action: 'none',
        reason: null,
      };
    }

    return {
      ...base,
      expectedSubtotalCents,
      expectedTotalCents,
      deltaCents: expectedSubtotalCents - application.subtotalCents,
      items,
      action: application.status === 'ISSUED' ? 'red_offset_and_reissue' : 'update_in_place',
      reason: REPAIR_RECHARGE_AMOUNT_REASON,
    };
  }

  private async applyRechargeRepairPlan(
    plan: RechargeRepairPlan,
    adminId: string,
  ): Promise<RechargeRepairPlan> {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await tx.invoiceApplication.findUnique({
          where: { id: plan.applicationId },
          include: {
            items: {
              orderBy: { createdAt: 'asc' },
              include: {
                order: {
                  select: {
                    id: true,
                    orderType: true,
                    amountCents: true,
                    currency: true,
                    status: true,
                    refundedAt: true,
                    paidAt: true,
                  },
                },
              },
            },
          },
        });
        if (!application) throw new InvoiceApplicationNotFoundError();

        const freshPlan = this.buildRechargeRepairPlan(application as RechargeRepairApplication);
        if (freshPlan.action !== plan.action) return freshPlan;

        await this.ensureNoOtherOccupyingInvoiceForOrders(
          tx,
          freshPlan.applicationId,
          freshPlan.orderIds,
        );

        if (freshPlan.action === 'update_in_place') {
          for (const item of freshPlan.items) {
            await tx.invoiceApplicationItem.update({
              where: { id: item.itemId },
              data: { principalCents: item.expectedPrincipalCents },
            });
          }
          const nextStatus = application.status === 'FAILED' ? 'PENDING_REVIEW' : application.status;
          await tx.invoiceApplication.update({
            where: { id: application.id },
            data: {
              status: nextStatus,
              subtotalCents: freshPlan.expectedSubtotalCents,
              totalCents: freshPlan.expectedTotalCents,
              failedReason: application.status === 'FAILED' ? null : application.failedReason,
            },
          });
          await this.eventService.record(
            {
              applicationId: application.id,
              fromStatus: application.status,
              toStatus: nextStatus,
              actorType: 'ADMIN',
              actorId: adminId,
              reason: REPAIR_RECHARGE_AMOUNT_REASON,
              metadata: rechargeRepairEventMetadata(freshPlan),
            },
            tx,
          );
          return freshPlan;
        }

        if (freshPlan.action === 'red_offset_and_reissue') {
          await tx.invoiceApplication.update({
            where: { id: application.id },
            data: {
              status: 'RED_OFFSET',
              voidReason: REPAIR_RECHARGE_AMOUNT_REASON,
            },
          });
          await this.eventService.record(
            {
              applicationId: application.id,
              fromStatus: 'ISSUED',
              toStatus: 'RED_OFFSET',
              actorType: 'ADMIN',
              actorId: adminId,
              reason: REPAIR_RECHARGE_AMOUNT_REASON,
              metadata: rechargeRepairEventMetadata(freshPlan),
            },
            tx,
          );

          const replacement = await tx.invoiceApplication.create({
            data: {
              applicationNo: generateApplicationNo(),
              userId: application.userId,
              tenantId: application.tenantId,
              profileId: application.profileId,
              profileSnapshot: (application.profileSnapshot ?? Prisma.JsonNull) as Prisma.InputJsonValue,
              currency: application.currency,
              subtotalCents: freshPlan.expectedSubtotalCents,
              taxAmountCents: application.taxAmountCents,
              totalCents: freshPlan.expectedTotalCents,
              status: 'PENDING_REVIEW',
              idempotencyKey: `${REPAIR_RECHARGE_AMOUNT_REASON}:${application.id}`,
              items: {
                createMany: {
                  data: application.items.map((item) => {
                    const expected = freshPlan.items.find((p) => p.itemId === item.id);
                    return {
                      orderId: item.orderId,
                      principalCents: expected?.expectedPrincipalCents ?? item.principalCents,
                      description: item.description,
                      productName: item.productName,
                      serviceStart: item.serviceStart,
                      serviceEnd: item.serviceEnd,
                      poNumber: item.poNumber,
                    };
                  }),
                },
              },
            },
            include: { items: true },
          });
          await this.eventService.record(
            {
              applicationId: replacement.id,
              fromStatus: null,
              toStatus: 'PENDING_REVIEW',
              actorType: 'ADMIN',
              actorId: adminId,
              reason: REPAIR_RECHARGE_AMOUNT_REASON,
              metadata: {
                ...rechargeRepairEventMetadata(freshPlan),
                replacesApplicationId: application.id,
                originalInvoiceNumber: application.invoiceNumber,
              },
            },
            tx,
          );
          return { ...freshPlan, replacementApplicationId: replacement.id };
        }

        return freshPlan;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async ensureNoOtherOccupyingInvoiceForOrders(
    tx: Prisma.TransactionClient,
    applicationId: string,
    orderIds: string[],
  ): Promise<void> {
    if (orderIds.length === 0) return;
    const occupied = await tx.invoiceApplicationItem.findFirst({
      where: {
        orderId: { in: orderIds },
        applicationId: { not: applicationId },
        application: { status: { in: INVOICE_OCCUPYING_STATUSES } },
      },
      select: { orderId: true },
    });
    if (occupied) {
      throw new InvoiceNothingToInvoiceError(occupied.orderId);
    }
  }

}

function rechargeRepairEventMetadata(plan: RechargeRepairPlan): Record<string, unknown> {
  return {
    action: plan.action,
    previousSubtotalCents: plan.previousSubtotalCents,
    expectedSubtotalCents: plan.expectedSubtotalCents,
    previousTotalCents: plan.previousTotalCents,
    expectedTotalCents: plan.expectedTotalCents,
    deltaCents: plan.deltaCents,
    orderIds: plan.orderIds,
    items: plan.items.map((item) => ({
      orderId: item.orderId,
      previousPrincipalCents: item.previousPrincipalCents,
      expectedPrincipalCents: item.expectedPrincipalCents,
    })),
  };
}

function summarizeRechargeRepair(
  dryRun: boolean,
  scanned: number,
  plans: RechargeRepairPlan[],
): RepairRechargeInvoicesResult {
  const actionable = plans.filter((plan) =>
    plan.action === 'update_in_place' || plan.action === 'red_offset_and_reissue',
  );
  const skipped = plans.filter((plan) => plan.action === 'skipped').length;
  return {
    dryRun,
    scanned,
    candidates: actionable.length,
    repaired: dryRun ? 0 : actionable.length,
    skipped,
    items: plans,
  };
}


// ============================
// 私有 helper
// ============================

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
