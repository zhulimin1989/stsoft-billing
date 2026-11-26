import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  OrderStatus,
  PayChannel,
  PaymentCheckoutInitState,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isBillingRuntime } from '../common/runtime/service-role';

@Injectable()
export class OrderTimeoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderTimeoutService.name);
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!isBillingRuntime()) {
      this.logger.log('Skip order timeout worker outside billing runtime');
      return;
    }
    this.interval = setInterval(() => {
      void this.expirePendingOrders();
    }, 60_000);
    this.interval.unref?.();
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async expirePendingOrders(): Promise<void> {
    const expiredAt = new Date();

    try {
      const orders = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.PENDING,
          OR: [
            {
              channel: PayChannel.WECHAT,
              createdAt: { lt: this.cutoff(2 * 60 * 60 * 1000) },
            },
            {
              channel: PayChannel.STRIPE,
              createdAt: { lt: this.cutoff(24 * 60 * 60 * 1000) },
            },
            {
              channel: PayChannel.ALIPAY,
              createdAt: { lt: this.cutoff(15 * 24 * 60 * 60 * 1000) },
            },
            {
              channel: PayChannel.BALANCE,
              createdAt: { lt: this.cutoff(5 * 60 * 1000) },
            },
            {
              channel: null,
              createdAt: { lt: this.cutoff(5 * 60 * 1000) },
            },
          ],
        },
        select: { id: true },
      });

      let expiredCount = 0;

      for (const order of orders) {
        try {
          const updated = await this.prisma.$transaction(async (tx) => {
            const result = await tx.order.updateMany({
              where: {
                id: order.id,
                status: OrderStatus.PENDING,
              },
              data: {
                status: OrderStatus.EXPIRED,
                expiredAt,
                checkoutInitState: PaymentCheckoutInitState.TERMINAL,
                checkoutLeaseId: null,
                checkoutLeaseExpiresAt: null,
                checkoutContextEncrypted: null,
                checkoutPayUrlEncrypted: null,
                checkoutPayUrlExpiresAt: null,
              },
            });

            if (result.count === 0) {
              return false;
            }

            await tx.orderAuditLog.create({
              data: {
                orderId: order.id,
                fromStatus: OrderStatus.PENDING,
                toStatus: OrderStatus.EXPIRED,
                operator: 'system',
                detail: '订单超时自动过期（按支付渠道窗口）',
              },
            });

            return true;
          });

          if (updated) {
            expiredCount += 1;
          }
        } catch (error) {
          this.logger.error(
            `订单超时处理失败: ${order.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      this.logger.log(`订单超时处理完成，过期 ${expiredCount} 笔订单`);
    } catch (error) {
      this.logger.error(
        '订单超时扫描失败',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private cutoff(windowMs: number): Date {
    return new Date(Date.now() - windowMs);
  }
}
