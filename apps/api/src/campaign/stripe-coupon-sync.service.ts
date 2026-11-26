import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require('stripe');

/**
 * StripeCouponSyncService — 在 Stripe 端维护 Coupon 资源的镜像。
 *
 * Campaign：每个 (currency, billingPeriod) 组合对应一个 amount_off coupon
 *           （duration='once'，保证续期按原价扣）。
 * DiscountCode：每个 code 对应一个 coupon（percent_off 或 amount_off，duration 可选）。
 *
 * Stripe Coupon 无法修改金额 → 价格调整时要 archive 旧 coupon + 创建新 coupon。
 * Stripe SDK 没有 archive 方法，只有 delete（软删但保留历史）。
 */
@Injectable()
export class StripeCouponSyncService {
  private readonly logger = new Logger(StripeCouponSyncService.name);
  private stripe: any = null;
  private readonly secretKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
  }

  /**
   * 是否配置了 Stripe（STRIPE_SECRET_KEY）。未配置 = 该环境没有 Stripe 结账路径，
   * 活动 coupon 既不会创建也不需要（cny 走微信/支付宝直减）。供展示侧判断是否要求 coupon 就绪。
   */
  isConfigured(): boolean {
    return Boolean(this.secretKey && this.secretKey.trim());
  }

  private getClient(): any {
    if (!this.secretKey) {
      throw new ServiceUnavailableException(
        'Stripe 未配置 STRIPE_SECRET_KEY，无法创建 Coupon',
      );
    }
    if (!this.stripe) {
      this.stripe = new Stripe(this.secretKey);
    }
    return this.stripe;
  }

  /**
   * 为活动创建一个 amount_off Coupon。
   * @param params.amountOffCents 折扣金额（整单原价 - 活动价，cents）
   * @param params.currency lowercase ISO 4217
   * @param params.metadata 打上业务 ID 方便排查
   */
  async createAmountOffCoupon(params: {
    name: string;
    amountOffCents: number;
    currency: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    if (params.amountOffCents <= 0) {
      throw new Error(
        `Coupon amount_off 必须大于 0，收到 ${params.amountOffCents}`,
      );
    }
    const stripe = this.getClient();
    const coupon = await stripe.coupons.create({
      name: params.name.slice(0, 40), // Stripe 限制 40 字符
      amount_off: params.amountOffCents,
      currency: params.currency,
      duration: 'once', // 续期按原价扣 — 这是整个折扣系统的业务保证
      metadata: params.metadata,
    });
    this.logger.log(
      `Stripe Coupon 创建成功 (amount_off): id=${coupon.id}, amount=${params.amountOffCents} ${params.currency}`,
    );
    return coupon.id;
  }

  /**
   * 为 DiscountCode 创建 Coupon（支持 percent_off / amount_off，duration 可选）
   */
  async createDiscountCodeCoupon(params: {
    name: string;
    discountType: 'percent_off' | 'amount_off';
    discountValue: number; // percent 是整数 1~99；amount 是 cents
    currency?: string;
    duration: 'once' | 'repeating' | 'forever';
    durationMonths?: number;
    metadata: Record<string, string>;
  }): Promise<string> {
    const stripe = this.getClient();

    const base: any = {
      name: params.name.slice(0, 40),
      duration: params.duration,
      metadata: params.metadata,
    };
    if (params.duration === 'repeating') {
      if (!params.durationMonths || params.durationMonths <= 0) {
        throw new Error('duration=repeating 时 durationMonths 必填且 > 0');
      }
      base.duration_in_months = params.durationMonths;
    }
    if (params.discountType === 'percent_off') {
      base.percent_off = params.discountValue;
    } else {
      base.amount_off = params.discountValue;
      if (!params.currency) {
        throw new Error('amount_off 时 currency 必填');
      }
      base.currency = params.currency;
    }
    const coupon = await stripe.coupons.create(base);
    this.logger.log(
      `Stripe Coupon 创建成功 (${params.discountType}): id=${coupon.id}`,
    );
    return coupon.id;
  }

  /**
   * 删除（archive）一个 Coupon。Stripe 的 delete 不影响已有订阅上的折扣。
   * 失败不抛 — 这只是资源清理，不是关键路径。
   */
  async archiveCoupon(couponId: string): Promise<void> {
    if (!couponId) return;
    try {
      const stripe = this.getClient();
      await stripe.coupons.del(couponId);
      this.logger.log(`Stripe Coupon 已删除: ${couponId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Stripe Coupon 删除失败 (忽略): ${couponId} → ${msg}`);
    }
  }

  /** 批量 archive（用于 Campaign 禁用/删除时清理所有币种 coupon）*/
  async archiveCouponsMap(couponIdsByKey: Record<string, string>): Promise<void> {
    for (const cid of Object.values(couponIdsByKey || {})) {
      await this.archiveCoupon(cid);
    }
  }
}
