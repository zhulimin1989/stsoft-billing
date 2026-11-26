import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AlertEventCategory,
  AlertEventSeverity,
  CodingPlanEntitlementStatus,
  CodingPlanFulfillmentMode,
  OrderItemStatus,
  OrderStatus,
  OrderType as PrismaOrderType,
  Prisma,
  PayChannel,
  RefundCompensationTask,
  RefundCompensationTaskAction,
  RefundCompensationTaskStatus,
  TransactionType as PrismaTransactionType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service';
import { CreditService } from '../billing/credit.service';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import { SubscriptionResolverService } from '../billing/subscription-resolver.service';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { PublisherRefundDrainSnapshot } from '../publisher/publisher.types';
import { PrismaService } from '../prisma/prisma.service';
import { centsToUsd, usdToCents } from '../billing/money';

export type RefundableOrder = Prisma.OrderGetPayload<{
  include: {
    plan: true;
    boosterPack: true;
    items: {
      include: { plan: true; boosterPack: true };
    };
  };
}>;

export type SelfOperatedCodingPlanRefundEvidence = {
  orderId: string;
  entitlementId: string;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  grantId: string;
  grantIdempotencyKey: string;
  grantCredits: number;
  grantBalanceVersion: bigint;
};

export class SelfOperatedCodingPlanRefundEligibilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SelfOperatedCodingPlanRefundEligibilityError';
  }
}

export class SelfOperatedCodingPlanRefundHoldRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfOperatedCodingPlanRefundHoldRetryError';
  }
}

type RefundableOrderItem = RefundableOrder['items'][number];
type RefundBalanceComponent = 'PAID' | 'BONUS';
type RefundDataClient = Prisma.TransactionClient | PrismaService;

export type StripeSubscriptionRefundEvidence = {
  refundedActivationIdempotencyKey: string;
  refundedSubscriptionPeriodId: string | null;
  originalGrantIdempotencyKey: string | null;
  initialActivationIdempotencyKey: string;
  renewalActivationIdempotencyPrefix: string;
  skipEntitlementCompensation: boolean;
};

type TaskDraft = {
  orderId: string;
  taskKey: string;
  action: RefundCompensationTaskAction;
  sequence: number;
  orderItemId?: string | null;
  userId: string;
  tenantId?: string | null;
  productId?: string | null;
  planId?: string | null;
  amountCents?: number | null;
  creditsAmount?: number | null;
  payload?: Prisma.InputJsonObject;
};

export type RefundCompensationRunResult = {
  complete: boolean;
  executed: number;
  failed: number;
  pending: number;
  manualReview: number;
  error?: string;
};

type ClaimedRefundCompensationTask = {
  task: RefundCompensationTask;
  leaseId: string;
};

const FULL_REFUND_COMPENSABLE_ITEM_STATUSES = new Set<OrderItemStatus>([
  OrderItemStatus.PENDING,
  OrderItemStatus.FULFILLED,
  OrderItemStatus.FULFILLING,
  OrderItemStatus.FAILED,
  OrderItemStatus.COMPENSATING,
  OrderItemStatus.COMPENSATION_FAILED,
]);

const TASK_RETRYABLE_STATUSES: RefundCompensationTaskStatus[] = [
  RefundCompensationTaskStatus.PENDING,
  RefundCompensationTaskStatus.FAILED,
];

const TASK_FORCE_RETRYABLE_STATUSES: RefundCompensationTaskStatus[] = [
  ...TASK_RETRYABLE_STATUSES,
  RefundCompensationTaskStatus.MANUAL_REVIEW,
];

const DEFAULT_TASK_MAX_ATTEMPTS = 12;
const RUNNING_TASK_STALE_MS = 10 * 60 * 1000;
const RECHARGE_BONUS_DESCRIPTION_PATTERN = /^recharge-bonus(?: tier:[^\s]+)?$/;
const SELF_OPERATED_REFUND_HOLD_PREFIX = 'refund-pending:';

@Injectable()
export class RefundCompensationService {
  private readonly logger = new Logger(RefundCompensationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly creditService: CreditService,
    private readonly subscriptionResolver: SubscriptionResolverService,
    private readonly subscriptionLifecycle: SubscriptionLifecycleService,
    @Optional() private readonly productSync?: ProductSyncNotifier,
    @Optional() private readonly publisherSync?: PublisherSyncService,
  ) {}

  async preflightUnusedSelfOperatedCodingPlanRefund(
    order: RefundableOrder,
    actualRefundCents: number,
  ): Promise<SelfOperatedCodingPlanRefundEvidence> {
    this.assertFullOrderRefund(order, actualRefundCents);
    const evidence = await this.resolveSelfOperatedCodingPlanRefundEvidence(
      this.prisma,
      order,
      [CodingPlanEntitlementStatus.ACTIVE],
      true,
    );
    if (!evidence) {
      throw this.codingPlanRefundError(
        'NOT_SELF_OPERATED',
        '该订单不是可自动退款的自营套餐',
      );
    }
    return evidence;
  }

  async claimUnusedSelfOperatedCodingPlanRefundHold(
    tx: Prisma.TransactionClient,
    orderId: string,
    actualRefundCents: number,
    expected: SelfOperatedCodingPlanRefundEvidence,
  ): Promise<void> {
    const lockKey = `coding-plan-active:${expected.tenantId}:${expected.productId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "coding_plan_entitlements"
      WHERE "id" = ${expected.entitlementId}
      FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw this.codingPlanRefundError(
        'ENTITLEMENT_MISSING',
        '自营套餐权益不存在，无法自动退款',
      );
    }
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        plan: true,
        boosterPack: true,
        items: { include: { plan: true, boosterPack: true } },
      },
    });
    if (!order) {
      throw this.codingPlanRefundError(
        'ORDER_MISSING',
        '退款订单不存在',
      );
    }
    this.assertFullOrderRefund(order, actualRefundCents);
    const current = await this.resolveSelfOperatedCodingPlanRefundEvidence(
      tx,
      order,
      [CodingPlanEntitlementStatus.ACTIVE],
      true,
    );
    if (!current || !this.sameSelfOperatedRefundEvidence(current, expected)) {
      throw this.codingPlanRefundError(
        'EVIDENCE_CHANGED',
        '退款资格已发生变化，请刷新订单后重试',
      );
    }
    const held = await tx.codingPlanEntitlement.updateMany({
      where: {
        id: current.entitlementId,
        orderId,
        status: CodingPlanEntitlementStatus.ACTIVE,
        fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
        lastError: null,
      },
      data: {
        status: CodingPlanEntitlementStatus.REFUNDING,
        lastError: this.selfOperatedRefundHoldMarker(orderId),
      },
    });
    if (held.count !== 1) {
      throw this.codingPlanRefundError(
        'HOLD_CONFLICT',
        '自营套餐退款冻结失败，请刷新订单后重试',
      );
    }
  }

  async assertUnusedSelfOperatedCodingPlanRefundHeld(
    order: RefundableOrder,
    actualRefundCents: number,
    expected?: SelfOperatedCodingPlanRefundEvidence,
  ): Promise<SelfOperatedCodingPlanRefundEvidence> {
    this.assertFullOrderRefund(order, actualRefundCents);
    const current = await this.resolveSelfOperatedCodingPlanRefundEvidence(
      this.prisma,
      order,
      [CodingPlanEntitlementStatus.REFUNDING],
      true,
    );
    if (!current) {
      throw this.codingPlanRefundError(
        'HOLD_MISSING',
        '自营套餐退款冻结状态缺失，未调用支付渠道',
      );
    }
    if (expected && !this.sameSelfOperatedRefundEvidence(current, expected)) {
      throw this.codingPlanRefundError(
        'EVIDENCE_CHANGED',
        '退款资格已发生变化，未调用支付渠道',
      );
    }
    return current;
  }

  async syncSelfOperatedCodingPlanRefundHoldRequired(
    entitlementId: string,
  ): Promise<void> {
    if (!this.publisherSync) {
      throw new SelfOperatedCodingPlanRefundHoldRetryError(
        'Publisher 同步服务不可用，退款资格已冻结并等待自动重试',
      );
    }
    let drainProof: PublisherRefundDrainSnapshot;
    try {
      await this.publisherSync
        .syncApiKeysByCodingPlanEntitlementIdRequired(entitlementId);
      drainProof = await this.publisherSync
        .establishCodingPlanRefundDrainRequired(entitlementId);
    } catch (error) {
      throw new SelfOperatedCodingPlanRefundHoldRetryError(
        `Publisher 退款关闸失败，已等待自动重试: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      !drainProof.ready
      || drainProof.in_flight > 0
      || drainProof.request_seen_key_count > 0
    ) {
      throw this.codingPlanRefundError(
        'GATEWAY_REQUEST_HISTORY_PRESENT',
        '该套餐的 API Key 已产生请求记录，不能按未使用套餐自动退款',
      );
    }
  }

  async releaseUnusedSelfOperatedCodingPlanRefundHold(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<string | null> {
    const entitlement = await tx.codingPlanEntitlement.findUnique({
      where: { orderId },
      select: {
        id: true,
        tenantId: true,
        productId: true,
        status: true,
        fulfillmentMode: true,
        lastError: true,
      },
    });
    if (
      !entitlement
      || entitlement.fulfillmentMode
        !== CodingPlanFulfillmentMode.platform_model_package
    ) {
      return null;
    }
    const marker = this.selfOperatedRefundHoldMarker(orderId);
    if (
      entitlement.status !== CodingPlanEntitlementStatus.REFUNDING
      || entitlement.lastError !== marker
    ) {
      throw new Error(
        `self-operated Coding Plan refund hold binding mismatch: ${orderId}`,
      );
    }
    const lockKey =
      `coding-plan-active:${entitlement.tenantId}:${entitlement.productId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const released = await tx.codingPlanEntitlement.updateMany({
      where: {
        id: entitlement.id,
        orderId,
        status: CodingPlanEntitlementStatus.REFUNDING,
        fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
        lastError: marker,
      },
      data: {
        status: CodingPlanEntitlementStatus.ACTIVE,
        lastError: null,
      },
    });
    if (released.count !== 1) {
      throw new Error(
        `self-operated Coding Plan refund hold release conflict: ${orderId}`,
      );
    }
    return entitlement.id;
  }

  async resyncReleasedSelfOperatedCodingPlanRefundHold(
    entitlementId: string,
  ): Promise<void> {
    if (!this.publisherSync) return;
    await this.publisherSync
      .syncApiKeysByCodingPlanEntitlementId(entitlementId)
      .catch((error) => {
        this.logger.error(
          `恢复自营套餐退款冻结后 Publisher 同步失败: entitlement=${entitlementId} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    await this.publisherSync
      .releaseCodingPlanRefundDrain(entitlementId)
      .catch((error) => {
        this.logger.error(
          `恢复自营套餐退款冻结后 drain 释放失败: entitlement=${entitlementId} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  async prepareAndRun(
    order: RefundableOrder,
    actualRefundCents: number,
    opts: {
      reason?: string;
      trigger?: string;
      skipEntitlementCompensation?: boolean;
      skipRechargeBalanceCompensation?: boolean;
    } = {},
  ): Promise<RefundCompensationRunResult> {
    await this.ensureTasksForOrder(
      order,
      actualRefundCents,
      opts.skipEntitlementCompensation ?? false,
      opts.skipRechargeBalanceCompensation ?? false,
    );
    return this.runOrderTasks(order.id, {
      force: true,
      reason: opts.reason,
      trigger: opts.trigger ?? 'inline',
    });
  }

  /**
   * Read-only proof that every local effect which would be compensated can be
   * mapped back to this exact order. PaymentService calls this after claiming
   * the order but before invoking an irreversible provider refund.
   *
   * Task creation and OrderItem state changes intentionally remain in
   * prepareAndRun(), after the provider has confirmed the refund.
   */
  async preflightOrderCompensation(
    order: RefundableOrder,
    actualRefundCents: number,
    opts: {
      skipEntitlementCompensation?: boolean;
      skipRechargeBalanceCompensation?: boolean;
    } = {},
  ): Promise<void> {
    if (
      !Number.isSafeInteger(actualRefundCents)
      || actualRefundCents <= 0
      || actualRefundCents > order.amountCents
    ) {
      throw new Error(
        `REFUND_COMPENSATION_AMOUNT_INVALID:${order.id}:${actualRefundCents}`,
      );
    }
    await this.buildTaskDrafts(
      order,
      actualRefundCents / order.amountCents,
      actualRefundCents,
      opts.skipEntitlementCompensation ?? false,
      opts.skipRechargeBalanceCompensation ?? false,
      true,
    );
  }

  async runDueTasks(
    opts: { batchSize?: number; trigger?: string } = {},
  ): Promise<{ orders: number; completed: number; failed: number; manualReview: number }> {
    const orderIds = await this.findDueOrderIds(opts.batchSize ?? 50);
    const result = { orders: orderIds.length, completed: 0, failed: 0, manualReview: 0 };
    for (const orderId of orderIds) {
      const run = await this.runOrderTasks(orderId, { trigger: opts.trigger ?? 'worker' });
      if (run.complete) result.completed += 1;
      if (run.failed > 0) result.failed += 1;
      if (run.manualReview > 0) result.manualReview += 1;
    }
    return result;
  }

  async runOrderTasks(
    orderId: string,
    opts: { force?: boolean; reason?: string; trigger?: string } = {},
  ): Promise<RefundCompensationRunResult> {
    const tasks = await this.prisma.refundCompensationTask.findMany({
      where: { orderId },
      orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
    });
    let executed = 0;
    let failed = 0;
    let error: string | undefined;

    for (const task of tasks) {
      if (task.status === RefundCompensationTaskStatus.SUCCEEDED) continue;
      if (!opts.force && task.status === RefundCompensationTaskStatus.MANUAL_REVIEW) break;
      if (
        !opts.force
        && TASK_RETRYABLE_STATUSES.includes(task.status)
        && task.nextRunAt.getTime() > Date.now()
      ) {
        break;
      }
      const claimed = await this.claimTask(task, Boolean(opts.force));
      if (!claimed) break;

      try {
        await this.executeTask(claimed.task);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        const marked = await this.markTaskFailed(claimed, error);
        if (!marked) {
          error = `REFUND_COMPENSATION_TASK_LEASE_LOST:${task.id}`;
        }
        failed += 1;
        break;
      }
      try {
        const marked = await this.markTaskSucceeded(claimed);
        if (!marked) {
          error = `REFUND_COMPENSATION_TASK_LEASE_LOST:${task.id}`;
          failed += 1;
          break;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        const marked = await this.markTaskFailed(claimed, error);
        if (!marked) {
          error = `REFUND_COMPENSATION_TASK_LEASE_LOST:${task.id}`;
        }
        failed += 1;
        break;
      }
      executed += 1;
    }

    const counts = await this.countOpenTasks(orderId);
    const complete = counts.pending === 0 && counts.failed === 0 && counts.running === 0 && counts.manualReview === 0;
    if (complete) {
      await this.markOrderRefundedIfComplete(orderId, opts.reason ?? '退款补偿完成');
    }

    return {
      complete,
      executed,
      failed,
      pending: counts.pending + counts.running,
      manualReview: counts.manualReview,
      error,
    };
  }

  private async ensureTasksForOrder(
    order: RefundableOrder,
    actualRefundCents: number,
    skipEntitlementCompensation = false,
    skipRechargeBalanceCompensation = false,
  ): Promise<void> {
    const refundRatio = actualRefundCents / order.amountCents;
    const drafts = await this.buildTaskDrafts(
      order,
      refundRatio,
      actualRefundCents,
      skipEntitlementCompensation,
      skipRechargeBalanceCompensation,
    );
    for (const draft of drafts) {
      await this.ensureTask(draft);
    }
  }

  private async buildTaskDrafts(
    order: RefundableOrder,
    refundRatio: number,
    actualRefundCents: number,
    skipEntitlementCompensation = false,
    skipRechargeBalanceCompensation = false,
    preflightOnly = false,
  ): Promise<TaskDraft[]> {
    const drafts: TaskDraft[] = [];
    let sequence = 10;
    const push = (draft: Omit<TaskDraft, 'orderId' | 'sequence' | 'userId' | 'tenantId'> & { tenantId?: string | null }) => {
      drafts.push({
        ...draft,
        orderId: order.id,
        sequence,
        userId: order.userId,
        tenantId: draft.tenantId ?? order.tenantId,
      });
      sequence += 10;
    };

    if (order.orderType === PrismaOrderType.BUNDLE) {
      const terminalItemStatus = this.resolveBundleRefundTerminalStatus(order);
      for (const item of order.items) {
        if (!this.shouldCompensateBundleItem(item, refundRatio)) continue;
        if (refundRatio === 1 && !preflightOnly) {
          await this.prisma.orderItem.update({
            where: { id: item.id },
            data: { status: OrderItemStatus.COMPENSATING },
          });
        }
        await this.addItemCreditTasks(push, order, item, refundRatio);
        if (refundRatio === 1) {
          if (item.plan) {
            if (!item.planId || !item.productId) {
              throw new Error(`bundle refund plan item is missing planId/productId: ${item.id}`);
            }
            const activationIdempotencyKey =
              `bundle:${order.id}:item:${item.id}:activation`;
            const [subscriptionActivation, codingEntitlement] =
              preflightOnly
              || item.status !== OrderItemStatus.FULFILLED
              ? await Promise.all([
                this.prisma.subscriptionPeriod.findUnique({
                  where: { activationIdempotencyKey },
                  select: {
                    id: true,
                    userId: true,
                    tenantId: true,
                    productId: true,
                    planId: true,
                  },
                }),
                this.prisma.codingPlanEntitlement.findUnique({
                  where: { orderId: item.id },
                  select: {
                    id: true,
                    userId: true,
                    tenantId: true,
                    productId: true,
                    planId: true,
                  },
                }),
              ])
              : [true, true];
            if (
              preflightOnly
              &&
              typeof subscriptionActivation !== 'boolean'
              &&
              subscriptionActivation
              && (
                subscriptionActivation.userId !== order.userId
                || subscriptionActivation.tenantId !== order.tenantId
                || subscriptionActivation.productId !== item.productId
                || subscriptionActivation.planId !== item.planId
              )
            ) {
              throw new Error(
                `REFUND_BUNDLE_PLAN_ACTIVATION_MISMATCH:${item.id}`,
              );
            }
            if (
              preflightOnly
              &&
              typeof codingEntitlement !== 'boolean'
              &&
              codingEntitlement
              && (
                codingEntitlement.userId !== order.userId
                || codingEntitlement.tenantId !== order.tenantId
                || codingEntitlement.productId !== item.productId
                || codingEntitlement.planId !== item.planId
              )
            ) {
              throw new Error(
                `REFUND_BUNDLE_CODING_ENTITLEMENT_MISMATCH:${item.id}`,
              );
            }
            if (
              preflightOnly
              &&
              item.status === OrderItemStatus.FULFILLED
              && !subscriptionActivation
              && !codingEntitlement
            ) {
              throw new Error(
                `REFUND_BUNDLE_PLAN_ACTIVATION_EVIDENCE_MISSING:${item.id}`,
              );
            }
            if (subscriptionActivation || codingEntitlement) {
              this.addPlanCancellationTasks(push, order, {
                keyScope: `item:${item.id}`,
                orderItemId: item.id,
                entitlementOrderId: item.id,
                productId: item.productId,
                planId: item.planId,
                activationIdempotencyKey,
              });
            }
          }
          push({
            taskKey: `refund:${order.id}:item:${item.id}:mark:${terminalItemStatus}`,
            action: RefundCompensationTaskAction.MARK_ORDER_ITEM_TERMINAL,
            orderItemId: item.id,
            payload: { terminalStatus: terminalItemStatus },
          });
        }
      }
      return drafts;
    }

    if (order.orderType === PrismaOrderType.BOOSTER_PACK && order.boosterPack) {
      const originalGrantIdempotencyKey = `booster:${order.id}`;
      const bonusGrant = await this.prisma.creditTransaction.findUnique({
        where: { idempotencyKey: originalGrantIdempotencyKey },
        select: {
          subscriptionId: true,
          userId: true,
          productId: true,
          type: true,
          creditsAmount: true,
        },
      });
      if (
        !bonusGrant
        || !bonusGrant.subscriptionId
        || bonusGrant.userId !== order.userId
        || bonusGrant.productId !== order.boosterPack.productId
        || bonusGrant.type !== 'BONUS_PURCHASE'
        || bonusGrant.creditsAmount <= 0
      ) {
        throw new Error(`REFUND_BOOSTER_CREDIT_EVIDENCE_MISSING:${order.id}`);
      }
      const creditsToDeduct = Math.round(
        bonusGrant.creditsAmount * refundRatio,
      );
      if (creditsToDeduct > 0) {
        push({
          taskKey: `refund:${order.id}:booster:credit`,
          action: RefundCompensationTaskAction.CREDIT_DEDUCT,
          productId: order.boosterPack.productId,
          creditsAmount: creditsToDeduct,
          payload: {
            source: `refund:order:${order.id}`,
            subscriptionId: bonusGrant.subscriptionId,
            bucket: 'BONUS',
            originalGrantIdempotencyKey,
          },
        });
      }
      push({
        taskKey: `refund:${order.id}:booster:notify`,
        action: RefundCompensationTaskAction.NOTIFY_CREDIT_CHANGED,
        productId: order.boosterPack.productId,
      });
      return drafts;
    }

    if (order.orderType === PrismaOrderType.RECHARGE) {
      // 已支付但账务主体在履约前失效的充值从未写入钱包。此时只做支付渠道退款，
      // 不得创建 REFUND_BALANCE，否则会从企业/个人任一钱包误扣一笔从未到账的余额。
      // 是否允许进入该模式由 PaymentService 基于 RECHARGE/ADJUST 流水与 BalanceGrant
      // 的缺失事实判定，并在每次退款重试时重新复核。
      if (skipRechargeBalanceCompensation) return drafts;

      const billingAccountId = order.billingAccountId?.trim();
      if (!billingAccountId) {
        throw new Error(`recharge refund order is missing billingAccountId: ${order.id}`);
      }
      if (preflightOnly) {
        await this.assertRechargePrincipalEvidence(order);
      }
      push({
        taskKey: `refund:${order.id}:recharge:principal`,
        action: RefundCompensationTaskAction.REFUND_BALANCE,
        productId: order.productId,
        amountCents: actualRefundCents,
        payload: {
          description: `refund:recharge:order:${order.id}:principal`,
          billingAccountId,
          refundComponent: 'PAID',
        },
      });
      const bonusCents = await this.getRechargeBonusCents(order);
      const bonusRefundCents = Math.round(bonusCents * refundRatio);
      if (bonusRefundCents > 0) {
        push({
          taskKey: `refund:${order.id}:recharge:bonus`,
          action: RefundCompensationTaskAction.REFUND_BALANCE,
          productId: order.productId,
          amountCents: bonusRefundCents,
          payload: {
            description: `refund:recharge:order:${order.id}:bonus`,
            billingAccountId,
            refundComponent: 'BONUS',
          },
        });
      }
      return drafts;
    }

    // skipEntitlementCompensation：仅用于「已支付但履约未产生任何权益/积分」的订单退款
    // （如自营换档抵扣安全闸拒单——entitlement 事务已回滚、未 grantQuota）。此时只退渠道款，
    // 不能跑「已履约订单」的权益补偿：否则 CREDIT_DEDUCT 会按目标套餐月额度到用户当前(旧)套餐误扣积分，
    // CANCEL_SUBSCRIPTION/CANCEL_CODING_PLAN 也可能误关同 product 的活动权益。
    if (order.plan && skipEntitlementCompensation && preflightOnly) {
      await this.assertOrderHasNoEntitlementEffects(order);
    }
    if (order.plan && !skipEntitlementCompensation) {
      const selfOperatedCodingPlanEvidence =
        await this.resolveSelfOperatedCodingPlanRefundEvidence(
          this.prisma,
          order,
          [
            CodingPlanEntitlementStatus.ACTIVE,
            CodingPlanEntitlementStatus.REFUNDING,
            CodingPlanEntitlementStatus.CANCELLED,
          ],
          false,
        );
      const stripeRefundEvidence =
        order.channel === PayChannel.STRIPE
        && order.tradeNo?.startsWith('sub_')
          ? await this.resolveStripeSubscriptionRefundEvidence(order)
          : null;
      const originalGrantIdempotencyKey =
        stripeRefundEvidence
          ? stripeRefundEvidence.originalGrantIdempotencyKey
          : `checkout:${order.id}`;
      if (
        order.plan.monthlyCredits > 0
        && !originalGrantIdempotencyKey
      ) {
        throw new Error(
          `REFUND_PLAN_CREDIT_EVIDENCE_MISSING:${order.id}`,
        );
      }
      const quotaGrant = order.plan.monthlyCredits > 0
        ? await this.prisma.creditTransaction.findUnique({
            where: { idempotencyKey: originalGrantIdempotencyKey! },
            select: {
              subscriptionId: true,
              userId: true,
              productId: true,
              type: true,
              creditsAmount: true,
            },
          })
        : null;
      if (
        order.plan.monthlyCredits > 0
        && (
          !quotaGrant
          || !quotaGrant.subscriptionId
          || quotaGrant.userId !== order.userId
          || quotaGrant.productId !== order.plan.productId
          || quotaGrant.type !== 'QUOTA_GRANT'
          || quotaGrant.creditsAmount <= 0
          || (
            selfOperatedCodingPlanEvidence
            && quotaGrant.subscriptionId
              !== selfOperatedCodingPlanEvidence.entitlementId
          )
        )
      ) {
        throw new Error(`REFUND_PLAN_CREDIT_EVIDENCE_MISSING:${order.id}`);
      }
      if (
        preflightOnly
        &&
        order.orderType === PrismaOrderType.SUBSCRIPTION
        && !stripeRefundEvidence
        && !selfOperatedCodingPlanEvidence
      ) {
        const activationIdempotencyKey =
          `checkout:${order.id}:activation`;
        const activation =
          await this.prisma.subscriptionPeriod.findUnique({
            where: { activationIdempotencyKey },
            select: {
              id: true,
              userId: true,
              tenantId: true,
              productId: true,
              planId: true,
            },
          });
        if (
          !activation
          || activation.userId !== order.userId
          || activation.tenantId !== order.tenantId
          || activation.productId !== order.plan.productId
          || activation.planId !== order.planId
          || (
            quotaGrant?.subscriptionId
            && quotaGrant.subscriptionId !== activation.id
          )
        ) {
          throw new Error(
            `REFUND_PLAN_ACTIVATION_EVIDENCE_MISSING:${order.id}`,
          );
        }
      }
      const creditsToReverse = Math.round(
        (quotaGrant?.creditsAmount ?? 0) * refundRatio,
      );
      if (creditsToReverse > 0) {
        push({
          taskKey: `refund:${order.id}:plan:credit`,
          action: RefundCompensationTaskAction.CREDIT_DEDUCT,
          productId: order.plan.productId,
          creditsAmount: creditsToReverse,
          payload: {
            source: `refund:${order.plan.name}:order:${order.id}`,
            subscriptionId: quotaGrant!.subscriptionId!,
            bucket: 'QUOTA',
            originalGrantIdempotencyKey: originalGrantIdempotencyKey!,
          },
        });
      }
      if (order.orderType === PrismaOrderType.SUBSCRIPTION && refundRatio === 1 && order.planId) {
        if (selfOperatedCodingPlanEvidence) {
          this.addCodingPlanCancellationTasks(push, order, {
            keyScope: 'plan',
            entitlementOrderId: order.id,
            entitlementId:
              selfOperatedCodingPlanEvidence.entitlementId,
            productId: selfOperatedCodingPlanEvidence.productId,
            planId: selfOperatedCodingPlanEvidence.planId,
          });
        } else {
          this.addPlanCancellationTasks(push, order, {
            keyScope: 'plan',
            entitlementOrderId: order.id,
            productId: order.plan.productId,
            planId: order.planId,
            activationIdempotencyKey:
              stripeRefundEvidence?.initialActivationIdempotencyKey
              ?? `checkout:${order.id}:activation`,
            renewalActivationIdempotencyPrefix:
              stripeRefundEvidence?.renewalActivationIdempotencyPrefix,
          });
        }
      }
    }

    return drafts;
  }

  private async resolveSelfOperatedCodingPlanRefundEvidence(
    db: RefundDataClient,
    order: RefundableOrder,
    allowedStatuses: CodingPlanEntitlementStatus[],
    requireUnused: boolean,
  ): Promise<SelfOperatedCodingPlanRefundEvidence | null> {
    if (
      order.orderType !== PrismaOrderType.SUBSCRIPTION
      || !order.productId
      || !order.planId
      || !order.plan
      || order.plan.productId !== order.productId
    ) {
      return null;
    }
    const entitlement = await db.codingPlanEntitlement.findUnique({
      where: { orderId: order.id },
      select: {
        id: true,
        orderId: true,
        userId: true,
        tenantId: true,
        productId: true,
        planId: true,
        fulfillmentMode: true,
        status: true,
        startedAt: true,
        expiresAt: true,
        lastError: true,
        providerEntitlementId: true,
        providerLineId: true,
        providerLineCode: true,
        providerCode: true,
        upstreamProductId: true,
      },
    });
    if (!entitlement) return null;
    if (
      entitlement.fulfillmentMode
      === CodingPlanFulfillmentMode.provider_resale
    ) {
      throw this.codingPlanRefundError(
        'PROVIDER_RESALE_UNSUPPORTED',
        '供应商转售套餐暂不支持自动退款，请人工核对上游权益',
      );
    }
    if (
      (order.prorationCreditCents ?? 0) > 0
      || order.prorationSourcePlanId
      || order.prorationSourceEntitlementId
      || order.prorationRemainingCredits != null
      || order.prorationMonthlyCredits != null
    ) {
      throw this.codingPlanRefundError(
        'SWITCH_ORDER_UNSUPPORTED',
        '换档或抵扣订单无法自动退款，请人工核对原套餐权益',
      );
    }
    if (
      entitlement.orderId !== order.id
      || entitlement.userId !== order.userId
      || entitlement.tenantId !== order.tenantId
      || entitlement.productId !== order.productId
      || entitlement.planId !== order.planId
      || entitlement.fulfillmentMode
        !== CodingPlanFulfillmentMode.platform_model_package
      || !allowedStatuses.includes(entitlement.status)
      || (entitlement.expiresAt && entitlement.expiresAt <= new Date())
      || entitlement.providerEntitlementId
      || entitlement.providerLineId
      || entitlement.providerLineCode
      || entitlement.providerCode
      || entitlement.upstreamProductId
    ) {
      throw this.codingPlanRefundError(
        'ENTITLEMENT_NOT_REVERSIBLE',
        '该订单不是独立首购的当前自营套餐，无法自动退款',
      );
    }
    const expectedLastError =
      entitlement.status === CodingPlanEntitlementStatus.ACTIVE
        ? null
        : entitlement.status === CodingPlanEntitlementStatus.REFUNDING
          ? this.selfOperatedRefundHoldMarker(order.id)
          : 'order_refunded';
    if (entitlement.lastError !== expectedLastError) {
      throw this.codingPlanRefundError(
        'ENTITLEMENT_PROVENANCE_MISMATCH',
        '自营套餐权益来源不完整，无法自动退款',
      );
    }

    const grantIdempotencyKey = `checkout:${order.id}`;
    const [grant, renewalAudit, autoRenewal, renewalCharge, providerEntitlement] =
      await Promise.all([
        db.creditTransaction.findUnique({
          where: { idempotencyKey: grantIdempotencyKey },
          select: {
            id: true,
            subscriptionId: true,
            userId: true,
            productId: true,
            type: true,
            creditsAmount: true,
            balanceVersion: true,
          },
        }),
        db.codingPlanEntitlement.findFirst({
          where: {
            id: { not: entitlement.id },
            userId: order.userId,
            tenantId: order.tenantId,
            productId: order.productId,
            lastError: `renewal-of:${entitlement.id}`,
          },
          select: { id: true },
        }),
        db.codingPlanAutoRenewal.findFirst({
          where: {
            OR: [
              { currentEntitlementId: entitlement.id },
              { sourceEntitlementId: entitlement.id },
            ],
          },
          select: { id: true },
        }),
        db.codingPlanRenewalCharge.findFirst({
          where: { orderId: order.id },
          select: { id: true },
        }),
        db.codingPlanProviderEntitlement.findUnique({
          where: { orderId: order.id },
          select: { id: true },
        }),
      ]);
    if (renewalAudit) {
      throw this.codingPlanRefundError(
        'RENEWED_ENTITLEMENT',
        '该套餐已发生续费，无法只撤销当前订单',
      );
    }
    if (autoRenewal || renewalCharge) {
      throw this.codingPlanRefundError(
        'AUTO_RENEWAL_DEPENDENCY',
        '该套餐关联连续订阅合约，请先人工核对并解约',
      );
    }
    if (providerEntitlement) {
      throw this.codingPlanRefundError(
        'PROVIDER_EFFECT_PRESENT',
        '该套餐存在上游权益记录，无法自动退款',
      );
    }
    if (
      !grant
      || !grant.subscriptionId
      || grant.subscriptionId !== entitlement.id
      || grant.userId !== order.userId
      || grant.productId !== order.productId
      || grant.type !== 'QUOTA_GRANT'
      || grant.creditsAmount <= 0
      || grant.balanceVersion == null
    ) {
      throw this.codingPlanRefundError(
        'INITIAL_GRANT_MISSING',
        '自营套餐首发额度证据不完整，无法自动退款',
      );
    }

    const evidence: SelfOperatedCodingPlanRefundEvidence = {
      orderId: order.id,
      entitlementId: entitlement.id,
      userId: order.userId,
      tenantId: order.tenantId,
      productId: order.productId,
      planId: order.planId,
      grantId: grant.id,
      grantIdempotencyKey,
      grantCredits: grant.creditsAmount,
      grantBalanceVersion: grant.balanceVersion,
    };
    if (!requireUnused) return evidence;

    const [
      transactions,
      balance,
      keys,
      settlementAnchor,
      tokenUsage,
    ] = await Promise.all([
      db.creditTransaction.findMany({
        where: { subscriptionId: entitlement.id },
        select: {
          id: true,
          idempotencyKey: true,
          type: true,
          creditsAmount: true,
          balanceVersion: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.creditBalanceState.findUnique({
        where: { subscriptionId: entitlement.id },
        select: { userId: true, quota: true, bonus: true, version: true },
      }),
      db.apiKey.findMany({
        where: { codingPlanEntitlementId: entitlement.id },
        select: { id: true },
      }),
      db.gatewayUsageSettlementAnchor.findFirst({
        where: { codingPlanEntitlementId: entitlement.id },
        select: { id: true },
      }),
      db.tokenUsage.findFirst({
        where: { codingPlanEntitlementId: entitlement.id },
        select: { id: true },
      }),
    ]);
    const onlyInitialGrant =
      transactions.length === 1
      && transactions[0].id === grant.id
      && transactions[0].idempotencyKey === grantIdempotencyKey
      && transactions[0].type === 'QUOTA_GRANT'
      && transactions[0].creditsAmount === grant.creditsAmount
      && String(transactions[0].balanceVersion)
        === String(grant.balanceVersion);
    const untouchedBalance =
      balance?.userId === order.userId
      && balance.quota === grant.creditsAmount
      && balance.bonus === 0
      && String(balance.version) === String(grant.balanceVersion);
    const gatewayEvent = keys.length > 0
      ? await db.gatewayBillingEvent.findFirst({
          where: {
            apiKeyId: { in: keys.map((key) => key.id) },
            createdAt: { gte: entitlement.startedAt },
          },
          select: { id: true },
        })
      : null;
    if (
      !onlyInitialGrant
      || !untouchedBalance
      || gatewayEvent
      || settlementAnchor
      || tokenUsage
    ) {
      throw this.codingPlanRefundError(
        'USAGE_DETECTED',
        '该套餐已产生用量、额度变化或请求记录，不能自动退款',
      );
    }
    return evidence;
  }

  private assertFullOrderRefund(
    order: RefundableOrder,
    actualRefundCents: number,
  ): void {
    if (
      !Number.isSafeInteger(actualRefundCents)
      || actualRefundCents !== order.amountCents
    ) {
      throw this.codingPlanRefundError(
        'PARTIAL_REFUND_UNSUPPORTED',
        '自营套餐仅支持整单全额退款',
      );
    }
  }

  private sameSelfOperatedRefundEvidence(
    current: SelfOperatedCodingPlanRefundEvidence,
    expected: SelfOperatedCodingPlanRefundEvidence,
  ): boolean {
    return current.orderId === expected.orderId
      && current.entitlementId === expected.entitlementId
      && current.userId === expected.userId
      && current.tenantId === expected.tenantId
      && current.productId === expected.productId
      && current.planId === expected.planId
      && current.grantId === expected.grantId
      && current.grantIdempotencyKey === expected.grantIdempotencyKey
      && current.grantCredits === expected.grantCredits
      && String(current.grantBalanceVersion)
        === String(expected.grantBalanceVersion);
  }

  private selfOperatedRefundHoldMarker(orderId: string): string {
    return `${SELF_OPERATED_REFUND_HOLD_PREFIX}${orderId}`;
  }

  private codingPlanRefundError(
    code: string,
    message: string,
  ): SelfOperatedCodingPlanRefundEligibilityError {
    return new SelfOperatedCodingPlanRefundEligibilityError(code, message);
  }

  private async assertOrderHasNoEntitlementEffects(
    order: RefundableOrder,
  ): Promise<void> {
    const initialActivationIdempotencyKey =
      `checkout:${order.id}:activation`;
    const renewalActivationIdempotencyPrefix =
      `stripe-renewal:${order.id}:`;
    const [period, creditGrant, codingEntitlement, providerEntitlement] =
      await Promise.all([
        this.prisma.subscriptionPeriod.findFirst({
          where: {
            OR: [
              {
                activationIdempotencyKey:
                  initialActivationIdempotencyKey,
              },
              {
                activationIdempotencyKey: {
                  startsWith: renewalActivationIdempotencyPrefix,
                },
              },
            ],
          },
          select: { id: true },
        }),
        this.prisma.creditTransaction.findFirst({
          where: {
            OR: [
              { idempotencyKey: `checkout:${order.id}` },
              {
                idempotencyKey: {
                  startsWith:
                    `quota:${renewalActivationIdempotencyPrefix}`,
                },
              },
              {
                idempotencyKey: {
                  startsWith: renewalActivationIdempotencyPrefix,
                },
              },
            ],
          },
          select: { id: true },
        }),
        this.prisma.codingPlanEntitlement.findUnique({
          where: { orderId: order.id },
          select: { id: true },
        }),
        this.prisma.codingPlanProviderEntitlement.findUnique({
          where: { orderId: order.id },
          select: { id: true },
        }),
      ]);
    if (period || creditGrant || codingEntitlement || providerEntitlement) {
      throw new Error(
        `REFUND_SKIP_ENTITLEMENT_EFFECTS_PRESENT:${order.id}`,
      );
    }
  }

  private async resolveStripeSubscriptionRefundEvidence(
    order: RefundableOrder,
  ): Promise<StripeSubscriptionRefundEvidence> {
    const task = await this.prisma.stripeSubscriptionCancellationTask.findUnique({
      where: { orderId: order.id },
      select: {
        subscriptionId: true,
        refundId: true,
        refundedInvoiceId: true,
        refundedActivationIdempotencyKey: true,
        refundedSubscriptionPeriodId: true,
        originalGrantIdempotencyKey: true,
        skipEntitlementCompensation: true,
        paymentProviderInstanceId: true,
        providerCanceledAt: true,
      },
    });
    if (
      !task
      || !task.providerCanceledAt
      || task.subscriptionId !== order.tradeNo
      || task.paymentProviderInstanceId
        !== (order.paymentProviderInstanceId ?? null)
      || !task.refundId?.trim()
      || !task.refundedInvoiceId.trim()
      || !task.refundedActivationIdempotencyKey.trim()
    ) {
      throw new Error(
        `REFUND_STRIPE_SUBSCRIPTION_PROVIDER_EVIDENCE_MISSING:${order.id}`,
      );
    }
    const evidence = await this.preflightStripeSubscriptionRefund(
      order,
      task.refundedInvoiceId,
      {
        skipEntitlementCompensation:
          task.skipEntitlementCompensation,
      },
    );
    if (
      evidence.refundedActivationIdempotencyKey
        !== task.refundedActivationIdempotencyKey
      || evidence.refundedSubscriptionPeriodId
        !== task.refundedSubscriptionPeriodId
      || evidence.originalGrantIdempotencyKey
        !== task.originalGrantIdempotencyKey
      || evidence.skipEntitlementCompensation
        !== task.skipEntitlementCompensation
    ) {
      throw new Error(
        `REFUND_STRIPE_SUBSCRIPTION_PERSISTED_EVIDENCE_MISMATCH:${order.id}`,
      );
    }
    return evidence;
  }

  async preflightStripeSubscriptionRefund(
    order: RefundableOrder,
    refundedInvoiceId: string,
    opts: { skipEntitlementCompensation?: boolean } = {},
  ): Promise<StripeSubscriptionRefundEvidence> {
    if (opts.skipEntitlementCompensation) {
      return this.resolveNoEffectStripeSubscriptionRefundEvidence(
        order,
        refundedInvoiceId,
      );
    }
    const evidence = await this.resolveLocalStripeSubscriptionRefundEvidence(
      order,
      refundedInvoiceId,
    );
    if (order.plan!.monthlyCredits <= 0) return evidence;
    if (!evidence.originalGrantIdempotencyKey) {
      throw new Error(`REFUND_PLAN_CREDIT_EVIDENCE_MISSING:${order.id}`);
    }
    const quotaGrant = await this.prisma.creditTransaction.findUnique({
      where: {
        idempotencyKey: evidence.originalGrantIdempotencyKey,
      },
      select: {
        subscriptionId: true,
        userId: true,
        productId: true,
        type: true,
        creditsAmount: true,
      },
    });
    if (
      !quotaGrant
      || !quotaGrant.subscriptionId
      || quotaGrant.subscriptionId
        !== evidence.refundedSubscriptionPeriodId
      || quotaGrant.userId !== order.userId
      || quotaGrant.productId !== order.plan!.productId
      || quotaGrant.type !== 'QUOTA_GRANT'
      || quotaGrant.creditsAmount <= 0
    ) {
      throw new Error(`REFUND_PLAN_CREDIT_EVIDENCE_MISSING:${order.id}`);
    }
    return evidence;
  }

  private async resolveLocalStripeSubscriptionRefundEvidence(
    order: RefundableOrder,
    refundedInvoiceId: string,
  ): Promise<StripeSubscriptionRefundEvidence> {
    const productId = order.plan?.productId;
    const planId = order.planId;
    if (
      order.channel !== PayChannel.STRIPE
      || !order.tradeNo?.startsWith('sub_')
      || !productId
      || !planId
      || !refundedInvoiceId.trim()
    ) {
      throw new Error(
        `REFUND_STRIPE_SUBSCRIPTION_ORDER_BINDING_MISSING:${order.id}`,
      );
    }
    const initialActivationIdempotencyKey =
      `checkout:${order.id}:activation`;
    const renewalActivationIdempotencyPrefix =
      `stripe-renewal:${order.id}:`;
    const refundedRenewalActivationIdempotencyKey =
      `stripe-renewal:${order.id}:invoice:${refundedInvoiceId}:order`;
    const checkoutSessionId = order.checkoutProviderReference?.trim() || null;

    const [refundedRenewalPeriod, initialInvoiceLedger, currentFamilyPeriod] =
      await Promise.all([
        this.prisma.subscriptionPeriod.findUnique({
          where: {
            activationIdempotencyKey:
              refundedRenewalActivationIdempotencyKey,
          },
          select: {
            id: true,
            userId: true,
            tenantId: true,
            productId: true,
            planId: true,
            activationIdempotencyKey: true,
          },
        }),
        checkoutSessionId
          ? this.prisma.stripePaymentLedger.findFirst({
              where: {
                orderId: order.id,
                transactionType: 'payment',
                checkoutSessionId,
                subscriptionId: order.tradeNo,
                invoiceId: refundedInvoiceId,
              },
              select: { id: true },
            })
          : Promise.resolve(null),
        this.prisma.subscriptionPeriod.findFirst({
          where: {
            userId: order.userId,
            tenantId: order.tenantId,
            productId,
            planId,
            OR: [
              {
                activationIdempotencyKey:
                  initialActivationIdempotencyKey,
              },
              {
                activationIdempotencyKey: {
                  startsWith: renewalActivationIdempotencyPrefix,
                },
              },
            ],
          },
          orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            activationIdempotencyKey: true,
          },
        }),
      ]);

    if (!currentFamilyPeriod?.activationIdempotencyKey) {
      throw new Error(
        `REFUND_STRIPE_SUBSCRIPTION_CURRENT_ACTIVATION_MISSING:${order.id}`,
      );
    }
    const isRenewalInvoice = Boolean(refundedRenewalPeriod);
    const isInitialInvoice = Boolean(initialInvoiceLedger);
    if (isRenewalInvoice === isInitialInvoice) {
      throw new Error(
        `REFUND_STRIPE_INVOICE_MAPPING_AMBIGUOUS:${order.id}:${refundedInvoiceId}`,
      );
    }

    if (refundedRenewalPeriod) {
      if (
        refundedRenewalPeriod.userId !== order.userId
        || refundedRenewalPeriod.tenantId !== order.tenantId
        || refundedRenewalPeriod.productId !== productId
        || refundedRenewalPeriod.planId !== planId
        || currentFamilyPeriod.activationIdempotencyKey
          !== refundedRenewalActivationIdempotencyKey
      ) {
        throw new Error(
          `REFUND_STRIPE_RENEWAL_ACTIVATION_MISMATCH:${order.id}:${refundedInvoiceId}`,
        );
      }
      return {
        refundedActivationIdempotencyKey:
          refundedRenewalActivationIdempotencyKey,
        refundedSubscriptionPeriodId:
          refundedRenewalPeriod.id,
        originalGrantIdempotencyKey:
          `quota:${refundedRenewalActivationIdempotencyKey}`,
        initialActivationIdempotencyKey,
        renewalActivationIdempotencyPrefix,
        skipEntitlementCompensation: false,
      };
    }

    if (
      !checkoutSessionId
      || currentFamilyPeriod.activationIdempotencyKey
        !== initialActivationIdempotencyKey
    ) {
      throw new Error(
        `REFUND_STRIPE_INITIAL_ACTIVATION_MISMATCH:${order.id}:${refundedInvoiceId}`,
      );
    }
    return {
      refundedActivationIdempotencyKey:
        initialActivationIdempotencyKey,
      refundedSubscriptionPeriodId:
        currentFamilyPeriod.id,
      originalGrantIdempotencyKey: `checkout:${order.id}`,
      initialActivationIdempotencyKey,
      renewalActivationIdempotencyPrefix,
      skipEntitlementCompensation: false,
    };
  }

  private async resolveNoEffectStripeSubscriptionRefundEvidence(
    order: RefundableOrder,
    refundedInvoiceId: string,
  ): Promise<StripeSubscriptionRefundEvidence> {
    const productId = order.plan?.productId;
    const planId = order.planId;
    const checkoutSessionId =
      order.checkoutProviderReference?.trim() || null;
    if (
      order.channel !== PayChannel.STRIPE
      || !order.tradeNo?.startsWith('sub_')
      || !productId
      || !planId
      || !checkoutSessionId
      || !refundedInvoiceId.trim()
    ) {
      throw new Error(
        `REFUND_STRIPE_NO_EFFECT_ORDER_BINDING_MISSING:${order.id}`,
      );
    }
    const initialActivationIdempotencyKey =
      `checkout:${order.id}:activation`;
    const renewalActivationIdempotencyPrefix =
      `stripe-renewal:${order.id}:`;
    const [initialInvoiceLedger, anyFamilyPeriod, checkoutGrant] =
      await Promise.all([
        this.prisma.stripePaymentLedger.findFirst({
          where: {
            orderId: order.id,
            transactionType: 'payment',
            checkoutSessionId,
            subscriptionId: order.tradeNo,
            invoiceId: refundedInvoiceId,
          },
          select: { id: true },
        }),
        this.prisma.subscriptionPeriod.findFirst({
          where: {
            userId: order.userId,
            tenantId: order.tenantId,
            productId,
            planId,
            OR: [
              {
                activationIdempotencyKey:
                  initialActivationIdempotencyKey,
              },
              {
                activationIdempotencyKey: {
                  startsWith: renewalActivationIdempotencyPrefix,
                },
              },
            ],
          },
          select: { id: true },
        }),
        this.prisma.creditTransaction.findUnique({
          where: { idempotencyKey: `checkout:${order.id}` },
          select: { id: true },
        }),
      ]);
    if (!initialInvoiceLedger || anyFamilyPeriod || checkoutGrant) {
      throw new Error(
        `REFUND_STRIPE_NO_EFFECT_EVIDENCE_AMBIGUOUS:${order.id}:${refundedInvoiceId}`,
      );
    }
    return {
      refundedActivationIdempotencyKey:
        initialActivationIdempotencyKey,
      refundedSubscriptionPeriodId: null,
      originalGrantIdempotencyKey: null,
      initialActivationIdempotencyKey,
      renewalActivationIdempotencyPrefix,
      skipEntitlementCompensation: true,
    };
  }

  private async addItemCreditTasks(
    push: (draft: Omit<TaskDraft, 'orderId' | 'sequence' | 'userId' | 'tenantId'> & { tenantId?: string | null }) => void,
    order: RefundableOrder,
    item: RefundableOrderItem,
    refundRatio: number,
  ): Promise<void> {
    if (item.plan) {
      if (item.plan.monthlyCredits > 0) {
        const quotaIdempotencyKey = `bundle:${order.id}:item:${item.id}:quota`;
        const quotaGrant = await this.prisma.creditTransaction.findUnique({
          where: { idempotencyKey: quotaIdempotencyKey },
          select: {
            subscriptionId: true,
            userId: true,
            productId: true,
            type: true,
            creditsAmount: true,
          },
        });
        if (!quotaGrant && item.status !== OrderItemStatus.FULFILLED) return;
        if (
          !quotaGrant
          || !quotaGrant.subscriptionId
          || quotaGrant.userId !== order.userId
          || quotaGrant.productId !== item.productId
          || quotaGrant.type !== 'QUOTA_GRANT'
          || quotaGrant.creditsAmount <= 0
        ) {
          throw new Error(`REFUND_BUNDLE_PLAN_CREDIT_EVIDENCE_MISSING:${item.id}`);
        }
        const creditsToReverse = Math.round(
          quotaGrant.creditsAmount * refundRatio,
        );
        if (creditsToReverse <= 0) return;
        push({
          taskKey: `refund:${order.id}:item:${item.id}:credit`,
          action: RefundCompensationTaskAction.CREDIT_DEDUCT,
          orderItemId: item.id,
          productId: item.productId,
          creditsAmount: creditsToReverse,
          payload: {
            source: `refund:${item.name}:order:${order.id}`,
            subscriptionId: quotaGrant.subscriptionId,
            bucket: 'QUOTA',
            originalGrantIdempotencyKey: quotaIdempotencyKey,
          },
        });
      }
      return;
    }

    if (item.boosterPack) {
      if (item.boosterPack.creditsAmount > 0) {
        const bonusGrant = await this.prisma.creditTransaction.findUnique({
          where: {
            idempotencyKey: `bundle:${order.id}:item:${item.id}:bonus`,
          },
          select: {
            subscriptionId: true,
            userId: true,
            productId: true,
            type: true,
            creditsAmount: true,
          },
        });
        if (!bonusGrant && item.status !== OrderItemStatus.FULFILLED) return;
        if (
          !bonusGrant
          || !bonusGrant.subscriptionId
          || bonusGrant.userId !== order.userId
          || bonusGrant.productId !== item.productId
          || bonusGrant.type !== 'BONUS_PURCHASE'
          || bonusGrant.creditsAmount <= 0
        ) {
          throw new Error(`REFUND_BUNDLE_BONUS_EVIDENCE_MISSING:${item.id}`);
        }
        const creditsToDeduct = Math.round(
          bonusGrant.creditsAmount * refundRatio,
        );
        if (creditsToDeduct <= 0) return;
        push({
          taskKey: `refund:${order.id}:item:${item.id}:booster-credit`,
          action: RefundCompensationTaskAction.CREDIT_DEDUCT,
          orderItemId: item.id,
          productId: item.productId,
          creditsAmount: creditsToDeduct,
          payload: {
            source: `refund:${item.name}:order:${order.id}`,
            subscriptionId: bonusGrant.subscriptionId,
            bucket: 'BONUS',
            originalGrantIdempotencyKey:
              `bundle:${order.id}:item:${item.id}:bonus`,
          },
        });
      }
      return;
    }

    throw new Error(`bundle refund item is missing refundable target: ${item.id}`);
  }

  private addPlanCancellationTasks(
    push: (draft: Omit<TaskDraft, 'orderId' | 'sequence' | 'userId' | 'tenantId'> & { tenantId?: string | null }) => void,
    order: RefundableOrder,
    input: {
      keyScope: string;
      orderItemId?: string | null;
      entitlementOrderId: string;
      productId?: string | null;
      planId?: string | null;
      activationIdempotencyKey?: string | null;
      renewalActivationIdempotencyPrefix?: string | null;
    },
  ): void {
    push({
      taskKey: `refund:${order.id}:${input.keyScope}:cancel-subscription`,
      action: RefundCompensationTaskAction.CANCEL_SUBSCRIPTION,
      orderItemId: input.orderItemId,
      productId: input.productId,
      planId: input.planId,
      payload:
        input.activationIdempotencyKey
        && input.renewalActivationIdempotencyPrefix
          ? {
              initialActivationIdempotencyKey:
                input.activationIdempotencyKey,
              renewalActivationIdempotencyPrefix:
                input.renewalActivationIdempotencyPrefix,
            }
          : input.activationIdempotencyKey
            ? { activationIdempotencyKey: input.activationIdempotencyKey }
            : undefined,
    });
    push({
      taskKey: `refund:${order.id}:${input.keyScope}:cancel-coding-plan`,
      action: RefundCompensationTaskAction.CANCEL_CODING_PLAN_ENTITLEMENT,
      orderItemId: input.orderItemId,
      productId: input.productId,
      planId: input.planId,
      payload: {
        entitlementOrderId: input.entitlementOrderId,
        ...(input.activationIdempotencyKey
          ? { activationIdempotencyKey: input.activationIdempotencyKey }
          : {}),
      },
    });
    push({
      taskKey: `refund:${order.id}:${input.keyScope}:publisher-sync`,
      action: RefundCompensationTaskAction.SYNC_PUBLISHER_KEYS,
      orderItemId: input.orderItemId,
      productId: input.productId,
      planId: input.planId,
      payload: { entitlementOrderId: input.entitlementOrderId },
    });
    if (input.productId) {
      push({
        taskKey: `refund:${order.id}:${input.keyScope}:invalidate-cache`,
        action: RefundCompensationTaskAction.INVALIDATE_SUBSCRIPTION_CACHE,
        orderItemId: input.orderItemId,
        productId: input.productId,
        planId: input.planId,
      });
      push({
        taskKey: `refund:${order.id}:${input.keyScope}:notify-credit`,
        action: RefundCompensationTaskAction.NOTIFY_CREDIT_CHANGED,
        orderItemId: input.orderItemId,
        productId: input.productId,
      });
    }
  }

  private addCodingPlanCancellationTasks(
    push: (draft: Omit<TaskDraft, 'orderId' | 'sequence' | 'userId' | 'tenantId'> & { tenantId?: string | null }) => void,
    order: RefundableOrder,
    input: {
      keyScope: string;
      entitlementOrderId: string;
      entitlementId: string;
      productId: string;
      planId: string;
    },
  ): void {
    push({
      taskKey: `refund:${order.id}:${input.keyScope}:cancel-coding-plan`,
      action: RefundCompensationTaskAction.CANCEL_CODING_PLAN_ENTITLEMENT,
      productId: input.productId,
      planId: input.planId,
      payload: {
        entitlementOrderId: input.entitlementOrderId,
        entitlementId: input.entitlementId,
        fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });
    push({
      taskKey: `refund:${order.id}:${input.keyScope}:publisher-sync`,
      action: RefundCompensationTaskAction.SYNC_PUBLISHER_KEYS,
      productId: input.productId,
      planId: input.planId,
      payload: {
        entitlementOrderId: input.entitlementOrderId,
        entitlementId: input.entitlementId,
      },
    });
    push({
      taskKey: `refund:${order.id}:${input.keyScope}:invalidate-cache`,
      action: RefundCompensationTaskAction.INVALIDATE_SUBSCRIPTION_CACHE,
      productId: input.productId,
      planId: input.planId,
    });
    push({
      taskKey: `refund:${order.id}:${input.keyScope}:notify-credit`,
      action: RefundCompensationTaskAction.NOTIFY_CREDIT_CHANGED,
      productId: input.productId,
    });
  }

  private async ensureTask(draft: TaskDraft): Promise<void> {
    const existing = await this.prisma.refundCompensationTask.findUnique({
      where: { taskKey: draft.taskKey },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.refundCompensationTask.create({
      data: {
        orderId: draft.orderId,
        orderItemId: draft.orderItemId ?? null,
        taskKey: draft.taskKey,
        action: draft.action,
        status: RefundCompensationTaskStatus.PENDING,
        sequence: draft.sequence,
        userId: draft.userId,
        tenantId: draft.tenantId ?? null,
        productId: draft.productId ?? null,
        planId: draft.planId ?? null,
        amountCents: draft.amountCents ?? null,
        creditsAmount: draft.creditsAmount ?? null,
        payload: draft.payload ?? Prisma.JsonNull,
        maxAttempts: DEFAULT_TASK_MAX_ATTEMPTS,
      },
    });
  }

  private async findDueOrderIds(batchSize: number): Promise<string[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - RUNNING_TASK_STALE_MS);
    const tasks = await this.prisma.refundCompensationTask.findMany({
      where: {
        OR: [
          {
            status: { in: TASK_RETRYABLE_STATUSES },
            nextRunAt: { lte: now },
          },
          {
            status: RefundCompensationTaskStatus.RUNNING,
            lockedAt: { lt: staleBefore },
          },
        ],
      },
      orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.max(batchSize * 5, batchSize),
      select: { orderId: true },
    });
    return Array.from(new Set(tasks.map((task) => task.orderId))).slice(0, batchSize);
  }

  private async claimTask(
    task: RefundCompensationTask,
    force: boolean,
  ): Promise<ClaimedRefundCompensationTask | null> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - RUNNING_TASK_STALE_MS);
    const leaseId = `refund-compensation:${randomUUID()}`;
    const claimableRetry: Prisma.RefundCompensationTaskWhereInput = {
      status: { in: force ? TASK_FORCE_RETRYABLE_STATUSES : TASK_RETRYABLE_STATUSES },
      ...(force ? {} : { nextRunAt: { lte: now } }),
    };
    const claimed = await this.prisma.refundCompensationTask.updateMany({
      where: {
        id: task.id,
        updatedAt: task.updatedAt,
        OR: [
          claimableRetry,
          {
            status: RefundCompensationTaskStatus.RUNNING,
            lockedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        status: RefundCompensationTaskStatus.RUNNING,
        lockedAt: now,
        lockedBy: leaseId,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;
    return {
      task: {
        ...task,
        status: RefundCompensationTaskStatus.RUNNING,
        attempts: task.attempts + 1,
        lockedAt: now,
        lockedBy: leaseId,
      },
      leaseId,
    };
  }

  private async executeTask(task: RefundCompensationTask): Promise<void> {
    switch (task.action) {
      case RefundCompensationTaskAction.REFUND_BALANCE:
        await this.executeRefundBalance(task);
        return;
      case RefundCompensationTaskAction.CREDIT_DEDUCT:
        await this.executeCreditDeduct(task);
        return;
      case RefundCompensationTaskAction.CANCEL_SUBSCRIPTION:
        await this.executeCancelSubscription(task);
        return;
      case RefundCompensationTaskAction.CANCEL_CODING_PLAN_ENTITLEMENT:
        await this.executeCancelCodingPlanEntitlement(task);
        return;
      case RefundCompensationTaskAction.SYNC_PUBLISHER_KEYS:
        await this.executePublisherSync(task);
        return;
      case RefundCompensationTaskAction.INVALIDATE_SUBSCRIPTION_CACHE:
        await this.executeInvalidateSubscriptionCache(task);
        return;
      case RefundCompensationTaskAction.NOTIFY_CREDIT_CHANGED:
        await this.executeNotifyCreditChanged(task);
        return;
      case RefundCompensationTaskAction.MARK_ORDER_ITEM_TERMINAL:
        await this.executeMarkOrderItemTerminal(task);
        return;
    }
  }

  private async executeRefundBalance(task: RefundCompensationTask): Promise<void> {
    const amountCents = task.amountCents;
    if (
      typeof amountCents !== 'number'
      || !Number.isSafeInteger(amountCents)
      || amountCents <= 0
    ) {
      throw new Error(
        `REFUND_BALANCE_COMPONENT_AMBIGUOUS:${task.taskKey}:amount_invalid`,
      );
    }
    if (!task.tenantId) {
      throw new Error('refund compensation balance refund requires tenantId');
    }
    const payload = this.payload(task);
    const description = this.stringPayload(payload, 'description') ?? `refund:order:${task.orderId}:${task.id}`;
    const hasPayloadBillingAccountId = Object.prototype.hasOwnProperty.call(
      payload,
      'billingAccountId',
    );
    const payloadBillingAccountId = payload.billingAccountId;
    if (
      hasPayloadBillingAccountId
      && (typeof payloadBillingAccountId !== 'string' || payloadBillingAccountId.length === 0)
    ) {
      throw new Error(
        `REFUND_BALANCE_COMPONENT_AMBIGUOUS:${task.taskKey}:billing_account_invalid`,
      );
    }
    const refundComponent = this.refundBalanceComponent(task, payload);
    // Order 是权威历史锚；payload 仅是新任务的冗余快照。旧任务没有该字段时也从 Order 恢复。
    const order = await this.prisma.order.findUnique({
      where: { id: task.orderId },
      select: { userId: true, tenantId: true, billingAccountId: true, orderType: true },
    });
    if (
      !order
      || order.orderType !== PrismaOrderType.RECHARGE
      || order.userId !== task.userId
      || order.tenantId !== task.tenantId
      || !order.billingAccountId
    ) {
      throw new Error(`refund compensation task subject does not match order: ${task.id}`);
    }
    if (hasPayloadBillingAccountId && payloadBillingAccountId !== order.billingAccountId) {
      throw new Error(
        `REFUND_BALANCE_COMPONENT_AMBIGUOUS:${task.taskKey}:billing_account_mismatch`,
      );
    }
    await this.billingService.refundBalance(
      task.userId,
      amountCents,
      description,
      task.orderId,
      task.productId,
      {
        tenantId: task.tenantId,
        billingAccountId: order.billingAccountId,
        refundComponent,
        idempotencyKey: task.taskKey,
      },
    );
  }

  private async executeCreditDeduct(task: RefundCompensationTask): Promise<void> {
    if (!task.creditsAmount || task.creditsAmount <= 0) return;
    const payload = this.payload(task);
    const source = this.stringPayload(payload, 'source') ?? `refund:order:${task.orderId}`;
    const subscriptionId = this.stringPayload(payload, 'subscriptionId');
    const bucket = this.stringPayload(payload, 'bucket');
    const originalGrantIdempotencyKey = this.stringPayload(
      payload,
      'originalGrantIdempotencyKey',
    );
    if (
      !subscriptionId
      || (bucket !== 'QUOTA' && bucket !== 'BONUS')
      || !originalGrantIdempotencyKey
    ) {
      throw new Error(`REFUND_CREDIT_PROVENANCE_MISSING:${task.taskKey}`);
    }
    const deductResult = await this.creditService.reverseGrantedCredits({
      subscriptionId,
      userId: task.userId,
      credits: task.creditsAmount,
      bucket,
      source,
      originalGrantIdempotencyKey,
      reversalIdempotencyKey: task.taskKey,
    });
    if (!deductResult.success) {
      this.logger.warn(
        `退款补偿积分回退不足: task=${task.id} order=${task.orderId} credits=${task.creditsAmount}`,
      );
      throw new Error(
        `REFUND_CREDIT_DEDUCT_INSUFFICIENT:${task.taskKey}:${task.creditsAmount}`,
      );
    }
  }

  private async executeCancelSubscription(task: RefundCompensationTask): Promise<void> {
    if (!task.tenantId) throw new Error('refund compensation subscription cancel requires tenantId');
    const payload = this.payload(task);
    const initialActivationIdempotencyKey = this.stringPayload(
      payload,
      'initialActivationIdempotencyKey',
    );
    const renewalActivationIdempotencyPrefix = this.stringPayload(
      payload,
      'renewalActivationIdempotencyPrefix',
    );
    if (
      initialActivationIdempotencyKey
      || renewalActivationIdempotencyPrefix
    ) {
      if (
        !initialActivationIdempotencyKey
        || !renewalActivationIdempotencyPrefix
        || !task.productId
        || !task.planId
      ) {
        throw new Error(
          `REFUND_SUBSCRIPTION_ACTIVATION_FAMILY_PROVENANCE_MISSING:${task.taskKey}`,
        );
      }
      const closed = await this.subscriptionLifecycle.closeActivationFamily({
        initialActivationIdempotencyKey,
        renewalActivationIdempotencyPrefix,
        userId: task.userId,
        tenantId: task.tenantId,
        productId: task.productId,
        planId: task.planId,
        endedAt: new Date(),
        terminationReason: 'order_refunded',
      });
      if (!closed) {
        throw new Error(
          `REFUND_SUBSCRIPTION_ACTIVATION_RECEIPT_MISSING:${initialActivationIdempotencyKey}`,
        );
      }
      return;
    }

    const activationIdempotencyKey = this.stringPayload(
      payload,
      'activationIdempotencyKey',
    );
    if (activationIdempotencyKey) {
      if (!task.productId || !task.planId) {
        throw new Error('anchored refund subscription cancel requires productId and planId');
      }
      const closed = await this.subscriptionLifecycle.closeActivation({
        activationIdempotencyKey,
        userId: task.userId,
        tenantId: task.tenantId,
        productId: task.productId,
        planId: task.planId,
        endedAt: new Date(),
        terminationReason: 'order_refunded',
      });
      if (!closed) {
        throw new Error(
          `REFUND_SUBSCRIPTION_ACTIVATION_RECEIPT_MISSING:${activationIdempotencyKey}`,
        );
      }
      return;
    }
    await this.subscriptionLifecycle.closeActive({
      tenantId: task.tenantId,
      productId: task.productId ?? undefined,
      planId: task.planId ?? undefined,
      status: 'CANCELLED',
      endedAt: new Date(),
      terminationReason: 'order_refunded',
    });
  }

  private async executeCancelCodingPlanEntitlement(task: RefundCompensationTask): Promise<void> {
    const entitlementOrderId = this.entitlementOrderId(task);
    const payload = this.payload(task);
    const entitlementId = this.stringPayload(payload, 'entitlementId');
    const fulfillmentMode = this.stringPayload(payload, 'fulfillmentMode');
    if (entitlementId) {
      if (fulfillmentMode !== CodingPlanFulfillmentMode.platform_model_package) {
        throw new Error(
          `REFUND_CODING_PLAN_FULFILLMENT_MODE_INVALID:${task.taskKey}`,
        );
      }
      const entitlement = await this.prisma.codingPlanEntitlement.findUnique({
        where: { id: entitlementId },
        select: {
          orderId: true,
          status: true,
          fulfillmentMode: true,
          lastError: true,
        },
      });
      if (
        entitlement?.orderId === entitlementOrderId
        && entitlement.status === CodingPlanEntitlementStatus.CANCELLED
        && entitlement.fulfillmentMode
          === CodingPlanFulfillmentMode.platform_model_package
        && entitlement.lastError === 'order_refunded'
      ) {
        return;
      }
      if (
        !entitlement
        || entitlement.orderId !== entitlementOrderId
        || entitlement.status !== CodingPlanEntitlementStatus.REFUNDING
        || entitlement.fulfillmentMode
          !== CodingPlanFulfillmentMode.platform_model_package
        || entitlement.lastError
          !== this.selfOperatedRefundHoldMarker(task.orderId)
      ) {
        throw new Error(
          `REFUND_CODING_PLAN_HOLD_EVIDENCE_MISSING:${task.taskKey}`,
        );
      }
      const cancelled = await this.prisma.codingPlanEntitlement.updateMany({
        where: {
          id: entitlementId,
          orderId: entitlementOrderId,
          status: CodingPlanEntitlementStatus.REFUNDING,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          lastError: this.selfOperatedRefundHoldMarker(task.orderId),
        },
        data: {
          status: CodingPlanEntitlementStatus.CANCELLED,
          lastError: 'order_refunded',
        },
      });
      if (cancelled.count !== 1) {
        throw new Error(
          `REFUND_CODING_PLAN_HOLD_CANCEL_CONFLICT:${task.taskKey}`,
        );
      }
      return;
    }
    await Promise.all([
      this.prisma.codingPlanEntitlement.updateMany({
        where: { orderId: entitlementOrderId },
        data: {
          status: 'CANCELLED',
          lastError: 'order_refunded',
        },
      }),
      this.prisma.codingPlanProviderEntitlement.updateMany({
        where: { orderId: entitlementOrderId },
        data: {
          status: 'CANCELLED',
          lastError: 'order_refunded',
        },
      }),
    ]);
  }

  private async executePublisherSync(task: RefundCompensationTask): Promise<void> {
    if (!this.publisherSync) return;
    const entitlementId = this.stringPayload(
      this.payload(task),
      'entitlementId',
    );
    if (entitlementId) {
      await this.publisherSync
        .syncApiKeysByCodingPlanEntitlementId(entitlementId);
      return;
    }
    const entitlementOrderId = this.entitlementOrderId(task);
    const entitlements = await this.prisma.codingPlanEntitlement.findMany({
      where: { orderId: entitlementOrderId },
      select: { id: true },
    });
    for (const entitlement of entitlements) {
      await this.publisherSync.syncApiKeysByCodingPlanEntitlementId(entitlement.id);
    }
  }

  private async executeInvalidateSubscriptionCache(task: RefundCompensationTask): Promise<void> {
    if (!task.productId) return;
    await this.subscriptionResolver.invalidateCache(task.userId, task.productId, task.tenantId);
  }

  private async executeNotifyCreditChanged(task: RefundCompensationTask): Promise<void> {
    if (!this.productSync || !task.productId) return;
    const [user, product] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: task.userId }, select: { email: true } }),
      this.prisma.product.findFirst({ where: { id: task.productId, deletedAt: null }, select: { slug: true } }),
    ]);
    if (user?.email && product?.slug) {
      await this.productSync.notifyCreditChanged(user.email, product.slug);
    }
  }

  private async executeMarkOrderItemTerminal(task: RefundCompensationTask): Promise<void> {
    this.resolveOrderItemTerminalStatus(task);
  }

  private resolveOrderItemTerminalStatus(
    task: RefundCompensationTask,
  ): OrderItemStatus {
    if (!task.orderItemId) {
      throw new Error(
        `refund compensation item marker is missing orderItemId: ${task.id}`,
      );
    }
    const payload = this.payload(task);
    const terminalStatus = this.stringPayload(payload, 'terminalStatus');
    if (
      terminalStatus !== OrderItemStatus.COMPENSATED &&
      terminalStatus !== OrderItemStatus.REFUNDED
    ) {
      throw new Error(`invalid terminal order item status: ${terminalStatus ?? 'missing'}`);
    }
    return terminalStatus;
  }

  private async markTaskSucceeded(
    claimed: ClaimedRefundCompensationTask,
  ): Promise<boolean> {
    const updateTask = (tx: Prisma.TransactionClient | PrismaService) =>
      tx.refundCompensationTask.updateMany({
        where: {
          id: claimed.task.id,
          status: RefundCompensationTaskStatus.RUNNING,
          lockedBy: claimed.leaseId,
        },
        data: {
          status: RefundCompensationTaskStatus.SUCCEEDED,
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
    const updated =
      claimed.task.action ===
      RefundCompensationTaskAction.MARK_ORDER_ITEM_TERMINAL
        ? await this.prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            const result = await updateTask(tx);
            if (result.count !== 1) return result;
            const terminalStatus =
              this.resolveOrderItemTerminalStatus(claimed.task);
            const itemUpdated = await tx.orderItem.updateMany({
              where: {
                id: claimed.task.orderItemId!,
                orderId: claimed.task.orderId,
              },
              data: { status: terminalStatus },
            });
            if (itemUpdated.count !== 1) {
              throw new Error(
                `refund compensation order item missing: ${claimed.task.orderItemId}`,
              );
            }
            return result;
          },
        )
        : await updateTask(this.prisma);
    if (updated.count !== 1) {
      this.logger.warn(
        `Refund compensation task lease lost before success write: task=${claimed.task.id}`,
      );
      return false;
    }
    return true;
  }

  private async markTaskFailed(
    claimed: ClaimedRefundCompensationTask,
    message: string,
  ): Promise<boolean> {
    const { task, leaseId } = claimed;
    const attempts = task.attempts;
    const manualReview = attempts >= task.maxAttempts;
    const status = manualReview
      ? RefundCompensationTaskStatus.MANUAL_REVIEW
      : RefundCompensationTaskStatus.FAILED;
    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const result = await tx.refundCompensationTask.updateMany({
          where: {
            id: task.id,
            status: RefundCompensationTaskStatus.RUNNING,
            lockedBy: leaseId,
          },
          data: {
            status,
            lockedAt: null,
            lockedBy: null,
            lastError: message,
            nextRunAt: manualReview ? task.nextRunAt : this.nextRetryAt(attempts),
          },
        });
        if (result.count !== 1) return result;

        if (task.orderItemId) {
          await tx.orderItem.updateMany({
            where: {
              id: task.orderItemId,
              orderId: task.orderId,
            },
            data: { status: OrderItemStatus.COMPENSATION_FAILED },
          });
        }
        if (manualReview) {
          await tx.alertEvent.create({
            data: {
              category: AlertEventCategory.PAYMENT,
              severity: AlertEventSeverity.CRITICAL,
              title: '退款补偿进入人工处理',
              message:
                `订单 ${task.orderId} 的退款补偿任务 ${task.taskKey} 多次失败，需人工处理`,
              sourceType: 'order',
              sourceId: task.orderId,
              userId: task.userId,
              context: JSON.stringify({
                taskId: task.id,
                taskKey: task.taskKey,
                action: task.action,
                attempts,
                error: message,
              }),
            },
          });
        }
        return result;
      },
    );
    if (updated.count !== 1) {
      this.logger.warn(
        `Refund compensation task lease lost before failure write: task=${task.id}`,
      );
      return false;
    }
    return true;
  }

  private async countOpenTasks(orderId: string): Promise<{
    pending: number;
    failed: number;
    running: number;
    manualReview: number;
  }> {
    const [pending, failed, running, manualReview] = await Promise.all([
      this.prisma.refundCompensationTask.count({
        where: { orderId, status: RefundCompensationTaskStatus.PENDING },
      }),
      this.prisma.refundCompensationTask.count({
        where: { orderId, status: RefundCompensationTaskStatus.FAILED },
      }),
      this.prisma.refundCompensationTask.count({
        where: { orderId, status: RefundCompensationTaskStatus.RUNNING },
      }),
      this.prisma.refundCompensationTask.count({
        where: { orderId, status: RefundCompensationTaskStatus.MANUAL_REVIEW },
      }),
    ]);
    return { pending, failed, running, manualReview };
  }

  private async markOrderRefundedIfComplete(orderId: string, detail: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (!order || order.status === OrderStatus.REFUNDED) return;
      const refundableStatuses: OrderStatus[] = [
        OrderStatus.REFUNDING,
        OrderStatus.REFUND_COMPENSATION_FAILED,
        OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      ];
      if (!refundableStatuses.includes(order.status)) return;

      const updated = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          status: OrderStatus.REFUNDED,
          refundedAt: new Date(),
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        },
      });
      if (updated.count !== 1) return;

      await tx.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.REFUNDED,
          operator: 'system',
          detail,
        },
      });
    });
  }

  private resolveBundleRefundTerminalStatus(order: RefundableOrder): OrderItemStatus {
    const hasUnfulfilledItems = order.items.some((item) => (
      item.status === OrderItemStatus.PENDING ||
      item.status === OrderItemStatus.FULFILLING ||
      item.status === OrderItemStatus.FAILED
    ));
    if (
      order.status === OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION ||
      hasUnfulfilledItems
    ) {
      return OrderItemStatus.COMPENSATED;
    }
    return OrderItemStatus.REFUNDED;
  }

  private shouldCompensateBundleItem(item: RefundableOrderItem, refundRatio: number): boolean {
    if (refundRatio === 1) {
      return FULL_REFUND_COMPENSABLE_ITEM_STATUSES.has(item.status);
    }
    return item.status === OrderItemStatus.FULFILLED;
  }

  private async assertRechargePrincipalEvidence(
    order: RefundableOrder,
  ): Promise<void> {
    const [principalTransactions, grant] = await Promise.all([
      this.prisma.balanceTransaction.findMany({
        where: {
          orderId: order.id,
          type: PrismaTransactionType.RECHARGE,
        },
        select: {
          operationKey: true,
          userId: true,
          tenantId: true,
          billingAccountId: true,
          productId: true,
          amountUsd: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.balanceGrant.findUnique({
        where: { orderId: order.id },
        select: {
          userId: true,
          tenantId: true,
          billingAccountId: true,
          productId: true,
          source: true,
          paidAmountUsd: true,
        },
      }),
    ]);
    if (principalTransactions.length !== 1 || !grant) {
      throw new Error(
        `RECHARGE_PRINCIPAL_EVIDENCE_AMBIGUOUS:${order.id}:cardinality`,
      );
    }
    const principal = principalTransactions[0];
    const expectedOperationKey = `balance:recharge:${order.id}:paid`;
    const expectedProductId = order.productId ?? null;
    if (
      (principal.operationKey !== null
        && principal.operationKey !== expectedOperationKey)
      || principal.userId !== order.userId
      || principal.tenantId !== order.tenantId
      || principal.billingAccountId !== order.billingAccountId
      || (principal.productId ?? null) !== expectedProductId
      || grant.userId !== order.userId
      || grant.tenantId !== order.tenantId
      || grant.billingAccountId !== order.billingAccountId
      || (grant.productId ?? null) !== expectedProductId
      || grant.source !== 'RECHARGE'
    ) {
      throw new Error(
        `RECHARGE_PRINCIPAL_EVIDENCE_AMBIGUOUS:${order.id}:ownership`,
      );
    }
    const principalCents = usdToCents(
      new Prisma.Decimal(principal.amountUsd),
    );
    const grantPaidCents = usdToCents(
      new Prisma.Decimal(grant.paidAmountUsd),
    );
    if (
      !Number.isSafeInteger(principalCents)
      || !Number.isSafeInteger(grantPaidCents)
      || principalCents !== order.amountCents
      || grantPaidCents !== order.amountCents
    ) {
      throw new Error(
        `RECHARGE_PRINCIPAL_EVIDENCE_AMBIGUOUS:${order.id}:amount`,
      );
    }
  }

  private async getRechargeBonusCents(order: RefundableOrder): Promise<number> {
    const persistedBonusCents = order.bonusCents ?? 0;
    if (!Number.isSafeInteger(persistedBonusCents) || persistedBonusCents < 0) {
      throw new Error(`RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:${order.id}:order_amount_invalid`);
    }

    const [grant, bonusTransactions] = await Promise.all([
      this.prisma.balanceGrant.findUnique({
        where: { orderId: order.id },
        select: {
          userId: true,
          tenantId: true,
          billingAccountId: true,
          productId: true,
          source: true,
          bonusAmountUsd: true,
        },
      }),
      this.prisma.balanceTransaction.findMany({
        where: {
          orderId: order.id,
          type: PrismaTransactionType.ADJUST,
          amountUsd: { gt: 0 },
        },
        select: {
          id: true,
          userId: true,
          tenantId: true,
          billingAccountId: true,
          productId: true,
          description: true,
          amountUsd: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    if (
      grant
      && (
        grant.userId !== order.userId
        || grant.tenantId !== order.tenantId
        || grant.source !== 'RECHARGE'
        || (grant.productId ?? null) !== (order.productId ?? null)
        || (order.billingAccountId !== null && grant.billingAccountId !== order.billingAccountId)
      )
    ) {
      throw new Error(`RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:${order.id}:grant_ownership_mismatch`);
    }

    const expectedBillingAccountId = grant?.billingAccountId ?? order.billingAccountId;
    let transactionTotalUsd = new Prisma.Decimal(0);
    const originalTransactions: Array<{ id: string; cents: number }> = [];
    for (const transaction of bonusTransactions) {
      if (
        transaction.userId !== order.userId
        || transaction.tenantId !== order.tenantId
        || (transaction.productId ?? null) !== (order.productId ?? null)
        || (expectedBillingAccountId !== null
          && transaction.billingAccountId !== expectedBillingAccountId)
      ) {
        throw new Error(
          `RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:${order.id}:transaction_ownership_mismatch`,
        );
      }
      const amountUsd = new Prisma.Decimal(transaction.amountUsd);
      const amountCents = usdToCents(amountUsd);
      if (
        !amountUsd.isFinite()
        || !Number.isSafeInteger(amountCents)
        || amountCents <= 0
        || !amountUsd.eq(centsToUsd(amountCents))
      ) {
        throw new Error(
          `RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:${order.id}:transaction_amount_invalid`,
        );
      }
      transactionTotalUsd = transactionTotalUsd.plus(amountUsd);
      if (RECHARGE_BONUS_DESCRIPTION_PATTERN.test(transaction.description)) {
        originalTransactions.push({ id: transaction.id, cents: amountCents });
      }
    }

    if (originalTransactions.length > 1) {
      throw new Error(
        `RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:${order.id}:multiple_original_transactions`,
      );
    }
    if (grant) {
      const grantBonusUsd = new Prisma.Decimal(grant.bonusAmountUsd);
      if (!grantBonusUsd.isFinite() || grantBonusUsd.lt(0) || !grantBonusUsd.eq(transactionTotalUsd)) {
        throw new Error(
          `RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:${order.id}:grant_transaction_total_mismatch`,
        );
      }
    }

    const immutableTransactionBonusCents = originalTransactions[0]?.cents ?? 0;
    if (persistedBonusCents > 0) {
      if (originalTransactions.length !== 1 || immutableTransactionBonusCents !== persistedBonusCents) {
        throw new Error(
          `RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:${order.id}:order_transaction_mismatch`,
        );
      }
      return persistedBonusCents;
    }
    return immutableTransactionBonusCents;
  }

  private entitlementOrderId(task: RefundCompensationTask): string {
    const payload = this.payload(task);
    return this.stringPayload(payload, 'entitlementOrderId') ?? task.orderItemId ?? task.orderId;
  }

  private payload(task: RefundCompensationTask): Record<string, unknown> {
    if (!task.payload || typeof task.payload !== 'object' || Array.isArray(task.payload)) return {};
    return task.payload as Record<string, unknown>;
  }

  private stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === 'string' ? value : undefined;
  }

  private refundBalanceComponent(
    task: Pick<RefundCompensationTask, 'orderId' | 'taskKey'>,
    payload: Record<string, unknown>,
  ): RefundBalanceComponent {
    const component = payload.refundComponent;
    if (component !== 'PAID' && component !== 'BONUS') {
      throw new Error(`REFUND_BALANCE_COMPONENT_AMBIGUOUS:${task.taskKey}:component_missing`);
    }
    const suffix = component === 'PAID' ? 'principal' : 'bonus';
    if (
      task.taskKey !== `refund:${task.orderId}:recharge:${suffix}`
      || this.stringPayload(payload, 'description')
        !== `refund:recharge:order:${task.orderId}:${suffix}`
    ) {
      throw new Error(`REFUND_BALANCE_COMPONENT_AMBIGUOUS:${task.taskKey}:identity_mismatch`);
    }
    const allowed = new Set(['description', 'billingAccountId', 'refundComponent']);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      throw new Error(`REFUND_BALANCE_COMPONENT_AMBIGUOUS:${task.taskKey}:payload_shape`);
    }
    return component;
  }

  private nextRetryAt(attempts: number): Date {
    const delayMs = Math.min(5 * 60 * 1000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
    return new Date(Date.now() + delayMs);
  }
}
