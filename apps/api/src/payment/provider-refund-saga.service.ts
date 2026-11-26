import { Injectable } from '@nestjs/common';
import {
  AlertEventCategory,
  AlertEventSeverity,
  OrderStatus,
  OrderType,
  PayChannel,
  Prisma,
  ProviderRefundIntent,
  ProviderRefundIntentStatus,
  TransactionType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRefundOutcome } from './provider-refund.types';
import {
  RefundCompensationService,
  SelfOperatedCodingPlanRefundEvidence,
} from './refund-compensation.service';

const RUNNING_STALE_MS = 10 * 60 * 1000;

export type PrepareProviderRefundIntentInput = {
  orderId: string;
  channel: PayChannel;
  tradeNo: string;
  requestNo: string;
  amountCents: number;
  currency: string;
  reason: string;
  paymentProviderInstanceId?: string | null;
  skipEntitlementCompensation?: boolean;
  skipRechargeBalanceCompensation?: boolean;
  preflightCompletedAt: Date;
};

export type ClaimedProviderRefundIntent = {
  task: ProviderRefundIntent;
  leaseId: string;
  previousStatus: ProviderRefundIntentStatus;
};

export type ClaimOrderAndPrepareProviderRefundInput =
  PrepareProviderRefundIntentInput & {
    fromStatus: OrderStatus;
    orderType: OrderType;
    requireNoRechargeWalletEffects?: boolean;
    selfOperatedCodingPlanRefund?: SelfOperatedCodingPlanRefundEvidence;
  };

@Injectable()
export class ProviderRefundSagaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refundCompensation: RefundCompensationService,
  ) {}

  /**
   * The order CAS and durable provider intent are one database commit. There is
   * no observable REFUNDING order without the recovery record required to
   * reconcile an uncertain remote call.
   */
  async claimOrderAndPrepare(
    input: ClaimOrderAndPrepareProviderRefundInput,
  ): Promise<{
    intent: ProviderRefundIntent;
    hasRechargeWalletEffects: boolean;
  }> {
    this.validatePrepareInput(input);
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.order.updateMany({
        where: { id: input.orderId, status: input.fromStatus },
        data: {
          status: OrderStatus.REFUNDING,
          refundReason: input.reason,
          refundAmountCents: input.amountCents,
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          `provider refund order claim conflict: ${input.orderId}`,
        );
      }

      let hasRechargeWalletEffects = false;
      if (input.orderType === OrderType.RECHARGE) {
        const [transaction, grant] = await Promise.all([
          tx.balanceTransaction.findFirst({
            where: {
              orderId: input.orderId,
              type: { in: [TransactionType.RECHARGE, TransactionType.ADJUST] },
            },
            select: { id: true },
          }),
          tx.balanceGrant.findUnique({
            where: { orderId: input.orderId },
            select: { id: true },
          }),
        ]);
        hasRechargeWalletEffects = Boolean(transaction || grant);
        if (
          input.requireNoRechargeWalletEffects
          && hasRechargeWalletEffects
        ) {
          throw new Error(
            `provider refund recharge effects appeared during claim: ${input.orderId}`,
          );
        }
      }
      if (input.selfOperatedCodingPlanRefund) {
        await this.refundCompensation
          .claimUnusedSelfOperatedCodingPlanRefundHold(
            tx,
            input.orderId,
            input.amountCents,
            input.selfOperatedCodingPlanRefund,
          );
      }

      const intent = await tx.providerRefundIntent.create({
        data: {
          orderId: input.orderId,
          channel: input.channel,
          tradeNo: input.tradeNo,
          requestNo: input.requestNo,
          amountCents: input.amountCents,
          currency: input.currency.toUpperCase(),
          reason: input.reason,
          paymentProviderInstanceId:
            input.paymentProviderInstanceId ?? null,
          skipEntitlementCompensation:
            input.skipEntitlementCompensation ?? false,
          skipRechargeBalanceCompensation:
            input.orderType === OrderType.RECHARGE
              ? !hasRechargeWalletEffects
              : input.skipRechargeBalanceCompensation ?? false,
          preflightCompletedAt: input.preflightCompletedAt,
          status: ProviderRefundIntentStatus.PREPARED,
        },
      });
      await tx.orderAuditLog.create({
        data: {
          orderId: input.orderId,
          fromStatus: input.fromStatus,
          toStatus: OrderStatus.REFUNDING,
          operator: 'system',
          detail: input.reason,
        },
      });
      return { intent, hasRechargeWalletEffects };
    });
  }

  async findByOrderId(orderId: string): Promise<ProviderRefundIntent | null> {
    return this.prisma.providerRefundIntent.findUnique({ where: { orderId } });
  }

  async findDue(batchSize = 50): Promise<ProviderRefundIntent[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - RUNNING_STALE_MS);
    return this.prisma.providerRefundIntent.findMany({
      where: {
        OR: [
          {
            status: {
              in: [
                ProviderRefundIntentStatus.PREPARED,
                ProviderRefundIntentStatus.PENDING_PROVIDER,
                ProviderRefundIntentStatus.PROVIDER_SUCCEEDED,
              ],
            },
            nextRunAt: { lte: now },
          },
          {
            status: ProviderRefundIntentStatus.RUNNING,
            lockedAt: { lt: staleBefore },
          },
        ],
      },
      orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(Math.max(Math.floor(batchSize), 1), 200),
    });
  }

  async claim(taskId: string): Promise<ClaimedProviderRefundIntent | null> {
    const task = await this.prisma.providerRefundIntent.findUnique({
      where: { id: taskId },
    });
    if (!task) return null;

    const now = new Date();
    const staleBefore = new Date(now.getTime() - RUNNING_STALE_MS);
    const isDue =
      (
        [
          ProviderRefundIntentStatus.PREPARED,
          ProviderRefundIntentStatus.PENDING_PROVIDER,
          ProviderRefundIntentStatus.PROVIDER_SUCCEEDED,
        ] as ProviderRefundIntentStatus[]
      ).includes(task.status)
      && task.nextRunAt.getTime() <= now.getTime();
    const isStaleRunning =
      task.status === ProviderRefundIntentStatus.RUNNING
      && Boolean(task.lockedAt && task.lockedAt < staleBefore);
    if (!isDue && !isStaleRunning) return null;

    const leaseId = `provider-refund:${randomUUID()}`;
    const claimed = await this.prisma.providerRefundIntent.updateMany({
      where: {
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt,
        ...(task.status === ProviderRefundIntentStatus.RUNNING
          ? { lockedAt: task.lockedAt }
          : {}),
      },
      data: {
        status: ProviderRefundIntentStatus.RUNNING,
        attempts: { increment: 1 },
        lockedAt: now,
        lockedBy: leaseId,
        providerAttemptedAt: task.providerAttemptedAt ?? now,
        lastError: null,
      },
    });
    if (claimed.count !== 1) return null;
    const refreshed = await this.prisma.providerRefundIntent.findUniqueOrThrow({
      where: { id: task.id },
    });
    return { task: refreshed, leaseId, previousStatus: task.status };
  }

  async recordProviderOutcome(
    claimed: ClaimedProviderRefundIntent,
    outcome: ProviderRefundOutcome,
  ): Promise<ProviderRefundIntentStatus> {
    const current = claimed.task;
    let status: ProviderRefundIntentStatus;
    let completedAt: Date | null = null;
    let providerConfirmedAt: Date | null = null;

    switch (outcome.state) {
      case 'SUCCEEDED':
        status = ProviderRefundIntentStatus.PROVIDER_SUCCEEDED;
        providerConfirmedAt = new Date();
        break;
      case 'FAILED':
        status = ProviderRefundIntentStatus.PROVIDER_FAILED;
        completedAt = new Date();
        break;
      case 'NOT_FOUND':
        // The deterministic request number makes a resubmission safe. A query
        // miss after an uncertain response is not proof of provider failure.
        status = current.attempts >= current.maxAttempts
          ? ProviderRefundIntentStatus.MANUAL_REVIEW
          : ProviderRefundIntentStatus.PREPARED;
        break;
      case 'PENDING':
      case 'UNKNOWN':
        status = current.attempts >= current.maxAttempts
          ? ProviderRefundIntentStatus.MANUAL_REVIEW
          : ProviderRefundIntentStatus.PENDING_PROVIDER;
        break;
    }

    let releasedEntitlementId: string | null = null;
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.providerRefundIntent.updateMany({
        where: {
          id: current.id,
          status: ProviderRefundIntentStatus.RUNNING,
          lockedBy: claimed.leaseId,
        },
        data: {
          status,
          providerRefundId:
            outcome.refundId ?? current.providerRefundId,
          providerStatus: outcome.providerStatus,
          providerConfirmedAt:
            providerConfirmedAt ?? current.providerConfirmedAt,
          nextRunAt:
            status === ProviderRefundIntentStatus.PROVIDER_SUCCEEDED
              ? new Date()
              : this.nextRetryAt(current.attempts),
          lockedAt: null,
          lockedBy: null,
          lastError: outcome.error ?? null,
          completedAt,
        },
      });
      if (updated.count !== 1) {
        throw new Error(`provider refund lease lost: ${current.id}`);
      }
      if (status === ProviderRefundIntentStatus.PROVIDER_FAILED) {
        releasedEntitlementId =
          await this.refundCompensation
            .releaseUnusedSelfOperatedCodingPlanRefundHold(
              tx,
              current.orderId,
            );
        const orderUpdated = await tx.order.updateMany({
          where: {
            id: current.orderId,
            status: OrderStatus.REFUNDING,
          },
          data: { status: OrderStatus.REFUND_FAILED },
        });
        if (orderUpdated.count !== 1) {
          throw new Error(
            `provider refund failed order transition conflict: ${current.orderId}`,
          );
        }
        await tx.orderAuditLog.create({
          data: {
            orderId: current.orderId,
            fromStatus: OrderStatus.REFUNDING,
            toStatus: OrderStatus.REFUND_FAILED,
            operator: 'system',
            detail:
              outcome.error
              ?? `支付渠道退款失败: ${outcome.providerStatus}`,
          },
        });
      }
      if (status === ProviderRefundIntentStatus.MANUAL_REVIEW) {
        await this.createManualReviewAlert(tx, current, outcome.error);
      }
    });
    if (releasedEntitlementId) {
      await this.refundCompensation
        .resyncReleasedSelfOperatedCodingPlanRefundHold(
          releasedEntitlementId,
        );
    }
    return status;
  }

  async releaseProviderSucceededForCompensationRetry(
    claimed: ClaimedProviderRefundIntent,
    error: string,
  ): Promise<void> {
    const status = claimed.task.attempts >= claimed.task.maxAttempts
      ? ProviderRefundIntentStatus.MANUAL_REVIEW
      : ProviderRefundIntentStatus.PROVIDER_SUCCEEDED;
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.updateClaimed(claimed, {
        status,
        nextRunAt: this.nextRetryAt(claimed.task.attempts),
        lockedAt: null,
        lockedBy: null,
        lastError: error,
      }, tx);
      if (status === ProviderRefundIntentStatus.MANUAL_REVIEW) {
        await this.createManualReviewAlert(tx, claimed.task, error);
      }
    });
  }

  async markCompleted(
    claimed: ClaimedProviderRefundIntent,
  ): Promise<void> {
    await this.updateClaimed(claimed, {
      status: ProviderRefundIntentStatus.COMPLETED,
      completedAt: new Date(),
      nextRunAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    });
  }

  private async updateClaimed(
    claimed: ClaimedProviderRefundIntent,
    data: Prisma.ProviderRefundIntentUpdateManyMutationInput,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const updated = await tx.providerRefundIntent.updateMany({
      where: {
        id: claimed.task.id,
        status: ProviderRefundIntentStatus.RUNNING,
        lockedBy: claimed.leaseId,
      },
      data,
    });
    if (updated.count !== 1) {
      throw new Error(`provider refund lease lost: ${claimed.task.id}`);
    }
  }

  private validatePrepareInput(
    input: PrepareProviderRefundIntentInput,
  ): void {
    if (!input.orderId.trim() || !input.tradeNo.trim() || !input.requestNo.trim()) {
      throw new Error('provider refund intent identity is incomplete');
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('provider refund intent amount must be a positive integer');
    }
    if (!input.currency.trim() || !input.reason.trim()) {
      throw new Error('provider refund intent currency/reason is incomplete');
    }
    const supportedChannels = new Set<PayChannel>([
        PayChannel.WECHAT,
        PayChannel.ALIPAY,
        PayChannel.STRIPE,
      ]);
    if (!supportedChannels.has(input.channel)) {
      throw new Error(`unsupported provider refund channel: ${input.channel}`);
    }
  }

  private async createManualReviewAlert(
    tx: Prisma.TransactionClient,
    task: ProviderRefundIntent,
    error?: string | null,
  ): Promise<void> {
    await tx.alertEvent.create({
      data: {
        category: AlertEventCategory.PAYMENT,
        severity: AlertEventSeverity.CRITICAL,
        title: '支付渠道退款进入人工处理',
        message:
          `订单 ${task.orderId} 的渠道退款超过自动恢复次数，订单保持 REFUNDING，需人工核对支付渠道结果`,
        sourceType: 'order',
        sourceId: task.orderId,
        context: JSON.stringify({
          providerRefundIntentId: task.id,
          channel: task.channel,
          tradeNo: task.tradeNo,
          requestNo: task.requestNo,
          providerRefundId: task.providerRefundId,
          attempts: task.attempts,
          error: error ?? null,
        }),
      },
    });
  }

  private nextRetryAt(attempts: number): Date {
    const delayMs = Math.min(
      60_000 * (2 ** Math.max(0, Math.min(attempts - 1, 8))),
      6 * 60 * 60 * 1000,
    );
    return new Date(Date.now() + delayMs);
  }
}
