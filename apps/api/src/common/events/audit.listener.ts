import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AppEvents,
  UserStatusChangedEvent,
  BalanceAdjustedEvent,
  OrderPaidEvent,
  ChannelUpdatedEvent,
} from './events';

@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  @OnEvent(AppEvents.USER_STATUS_CHANGED)
  async handleUserStatusChanged(event: UserStatusChangedEvent) {
    try {
      const targetUserId = event.targetUserId ?? event.userId;
      await this.prisma.auditLog.create({
        data: {
          userId: event.performedBy,
          targetUserId,
          resourceId: event.resourceId ?? event.userId,
          action: 'user.status.changed',
          resource: 'User',
          detail: JSON.stringify({ targetUserId, isActive: event.isActive }),
        },
      });
    } catch (err) {
      this.logger.error('Failed to log audit: user.status.changed', err);
    }
  }

  @OnEvent(AppEvents.BALANCE_ADJUSTED)
  async handleBalanceAdjusted(event: BalanceAdjustedEvent) {
    try {
      const targetUserId = event.targetUserId ?? event.userId;
      await this.prisma.auditLog.create({
        data: {
          userId: event.performedBy,
          targetUserId,
          resourceId: event.resourceId,
          action: 'billing.balance.adjusted',
          resource: 'Balance',
          detail: JSON.stringify({ targetUserId, amountCents: event.amountCents, description: event.description }),
        },
      });
    } catch (err) {
      this.logger.error('Failed to log audit: billing.balance.adjusted', err);
    }
  }

  @OnEvent(AppEvents.ORDER_PAID)
  async handleOrderPaid(event: OrderPaidEvent) {
    try {
      const targetUserId = event.targetUserId ?? event.userId;
      await this.prisma.auditLog.create({
        data: {
          targetUserId,
          resourceId: event.resourceId ?? event.orderId,
          action: 'payment.order.paid',
          resource: 'Order',
          detail: JSON.stringify({ orderId: event.orderId, userId: event.userId, amountCents: event.amountCents, channel: event.channel }),
        },
      });
    } catch (err) {
      this.logger.error('Failed to log audit: payment.order.paid', err);
    }
  }

  @OnEvent(AppEvents.CHANNEL_UPDATED)
  async handleChannelUpdated(event: ChannelUpdatedEvent) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: event.performedBy,
          targetUserId: event.targetUserId,
          resourceId: event.resourceId ?? event.channelId,
          action: `channel.${event.action}`,
          resource: 'Channel',
          detail: JSON.stringify({ channelId: event.channelId, action: event.action }),
        },
      });
    } catch (err) {
      this.logger.error(`Failed to log audit: channel.${event.action}`, err);
    }
  }

  constructor(private readonly prisma: PrismaService) {}
}
